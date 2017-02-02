import getRethink from 'server/database/rethinkDriver';
import {
  ensureUniqueId,
  requireUserInOrg,
  getUserId,
  requireAuth,
  requireSUOrTeamMember,
  requireWebsocket
} from 'server/utils/authorization';
import {errorObj, handleSchemaErrors} from 'server/utils/utils';
import {Invitee} from 'server/graphql/models/Invitation/invitationSchema';
import {
  GraphQLNonNull,
  GraphQLBoolean,
  GraphQLID,
  GraphQLString,
  GraphQLInt,
  GraphQLList
} from 'graphql';
import {TeamInput} from './teamSchema';
import {asyncInviteTeam} from 'server/graphql/models/Invitation/helpers';
import shortid from 'shortid';
import {
  CHECKIN,
  DONE,
  LOBBY,
  UPDATES,
  FIRST_CALL,
  AGENDA_ITEMS,
  LAST_CALL,
  SUMMARY,
  phaseArray,
  phaseOrder
} from 'universal/utils/constants';
import addSeedProjects from './helpers/addSeedProjects';
import createTeamAndLeader from './helpers/createTeamAndLeader';
import tmsSignToken from 'server/utils/tmsSignToken';
import {makeCheckinGreeting, makeCheckinQuestion} from 'universal/utils/makeCheckinGreeting';
import getWeekOfYear from 'universal/utils/getWeekOfYear';
import {makeSuccessExpression, makeSuccessStatement} from 'universal/utils/makeSuccessCopy';
import hasPhaseItem from 'universal/modules/meeting/helpers/hasPhaseItem';
import makeStep2Schema from 'universal/validation/makeStep2Schema';
import makeAddTeamServerSchema from 'universal/validation/makeAddTeamServerSchema';
import {TRIAL_EXPIRES_SOON, REQUEST_NEW_USER} from 'universal/utils/constants';
import ms from 'ms';
import createStripeOrg from 'server/graphql/models/Organization/addOrg/createStripeOrg';

export default {
  moveMeeting: {
    type: GraphQLBoolean,
    description: 'Update the facilitator. If this is new territory for the meetingPhaseItem, advance that, too.',
    args: {
      teamId: {
        type: new GraphQLNonNull(GraphQLID),
        description: 'The teamId to make sure the socket calling has permission'
      },
      nextPhase: {
        // http://stackoverflow.com/questions/37620012/passing-graphql-enumerated-value-type-as-argument-to-function
        type: GraphQLString,
        description: 'The desired phase for the meeting'
      },
      nextPhaseItem: {
        type: GraphQLInt,
        description: 'The item within the phase to set the meeting to'
      },
      force: {
        type: GraphQLBoolean,
        description: 'If true, execute the mutation without regard for meeting flow'
      }
    },
    async resolve(source, {force, teamId, nextPhase, nextPhaseItem}, {authToken, socket}) {
      const r = getRethink();
      // TODO: transform these console statements into configurable logger statements:
      /*
       console.log('moveMeeting()');
       console.log('teamId');
       console.log(teamId);
       console.log('nextPhase');
       console.log(nextPhase);
       console.log('nextPhaseItem');
       console.log(nextPhaseItem);
       */
      // AUTH
      requireSUOrTeamMember(authToken, teamId);
      requireWebsocket(socket);

      // BAILOUT
      if (force) {
        // use this if the meeting hit an infinite redirect loop. should never occur
        await r.table('Team').get(teamId).update({
          facilitatorPhase: CHECKIN,
          facilitatorPhaseItem: 1,
          meetingPhase: CHECKIN,
          meetingPhaseItem: 1,
        });
        return true;
      }

      // VALIDATION
      if (nextPhase && !phaseArray.includes(nextPhase)) {
        throw errorObj({_error: `${nextPhase} is not a valid phase`});
      }
      const team = await r.table('Team').get(teamId);
      const {activeFacilitator, facilitatorPhase, meetingPhase, facilitatorPhaseItem, meetingPhaseItem} = team;
      if (nextPhase === CHECKIN || nextPhase === UPDATES) {
        const teamMembersCount = await r.table('TeamMember')
          .getAll(teamId, {index: 'teamId'})
          .filter({isNotRemoved: true})
          .count();
        if (nextPhaseItem < 1 || nextPhaseItem > teamMembersCount) {
          throw errorObj({_error: 'We don\'t have that many team members!'});
        }
      } else if (nextPhase === AGENDA_ITEMS) {
        const agendaItemCount = await r.table('AgendaItem')
          .getAll(teamId, {index: 'teamId'})
          .filter({isActive: true})
          .count();
        if (nextPhaseItem < 1 || nextPhaseItem > agendaItemCount) {
          throw errorObj({_error: 'We don\'t have that many agenda items!'});
        }
      } else if (nextPhase === FIRST_CALL && phaseOrder(meetingPhase) > phaseOrder(FIRST_CALL)) {
        throw errorObj({_error: 'You can\'t visit first call twice!'});
      } else if (nextPhase && nextPhaseItem) {
        throw errorObj({_error: `${nextPhase} does not have phase items, but you said ${nextPhaseItem}`});
      }

      const userId = getUserId(authToken);
      const teamMemberId = `${userId}::${teamId}`;
      if (activeFacilitator !== teamMemberId) {
        throw errorObj({_error: 'Only the facilitator can advance the meeting'});
      }

      // RESOLUTION
      const isSynced = facilitatorPhase === meetingPhase && facilitatorPhaseItem === meetingPhaseItem;
      let incrementsProgress;
      if (nextPhase && (phaseOrder(nextPhase) - phaseOrder(meetingPhase) === 1)) {
        // console.log('phaseOrder increments progress');
        // meeting phase has progressed forward:
        incrementsProgress = true;
      } else if (!nextPhase && hasPhaseItem(meetingPhase)) {
        // console.log('phaseItem increments progress');
        // same phase, and meeting phase item has incremented forward:
        incrementsProgress = nextPhaseItem - meetingPhaseItem === 1;
      } else if (meetingPhase === FIRST_CALL && nextPhase === LAST_CALL) {
        const agendaItemCount = await r.table('AgendaItem')
          .getAll(teamId, {index: 'teamId'})
          .filter({isActive: true})
          .count();
        incrementsProgress = agendaItemCount === 0;
      }
      const moveMeeting = isSynced && incrementsProgress;
      if (facilitatorPhase === AGENDA_ITEMS) {
        if (moveMeeting || phaseOrder(meetingPhase) > phaseOrder(AGENDA_ITEMS)) {
          await r.table('AgendaItem')
            .getAll(teamId, {index: 'teamId'})
            .filter({isActive: true})
            .orderBy('sortOrder')
            .nth(facilitatorPhaseItem - 1)
            .update({isComplete: true});
        }
      }
      /*
       console.log('moveMeeting');
       console.log(moveMeeting);
       */

      const updatedState = {
        facilitatorPhaseItem: nextPhaseItem,
      };
      if (moveMeeting) {
        updatedState.meetingPhaseItem = nextPhaseItem;
      }
      if (nextPhase) {
        updatedState.facilitatorPhase = nextPhase;
        if (moveMeeting) {
          updatedState.meetingPhase = nextPhase;
        }
      }
      await r.table('Team').get(teamId).update(updatedState);
      /*
       console.log('updatedState');
       console.log(updatedState);
       console.log('------------');
       */
      return true;
    }
  },
  startMeeting: {
    type: GraphQLBoolean,
    description: 'Start a meeting from the lobby',
    args: {
      facilitatorId: {
        type: new GraphQLNonNull(GraphQLID),
        description: 'The facilitator teamMemberId for this meeting'
      }
    },
    async resolve(source, {facilitatorId}, {authToken, socket}) {
      const r = getRethink();

      // AUTH
      // facilitatorId is of format 'userId::teamId'
      const [, teamId] = facilitatorId.split('::');
      requireSUOrTeamMember(authToken, teamId);
      requireWebsocket(socket);

      // RESOLUTION
      const facilitatorMembership = await r.table('TeamMember').get(facilitatorId);
      if (!facilitatorMembership || !facilitatorMembership.isNotRemoved) {
        throw errorObj({_error: 'facilitator is not active on that team'});
      }

      const now = new Date();
      const meetingId = shortid.generate();
      const week = getWeekOfYear(now);

      const updatedTeam = {
        checkInGreeting: makeCheckinGreeting(week),
        checkInQuestion: makeCheckinQuestion(week),
        meetingId,
        activeFacilitator: facilitatorId,
        facilitatorPhase: CHECKIN,
        facilitatorPhaseItem: 1,
        meetingPhase: CHECKIN,
        meetingPhaseItem: 1,
      };
      await r.table('Team').get(teamId).update(updatedTeam)
        .do(() => {
          return r.table('Meeting').getAll(teamId, {index: 'teamId'}).count();
        })
        .do((meetingCount) => {
          return r.table('Meeting').insert({
            id: meetingId,
            createdAt: now,
            meetingNumber: meetingCount.add(1),
            teamId,
            teamName: r.table('Team').get(teamId)('name')
          });
        });
      return true;
    }
  },
  endMeeting: {
    type: GraphQLBoolean,
    description: 'Finish a meeting and go to the summary',
    args: {
      teamId: {
        type: new GraphQLNonNull(GraphQLID),
        description: 'The team that will be having the meeting'
      }
    },
    async resolve(source, {teamId}, {authToken, socket}) {
      const r = getRethink();

      // AUTH
      requireSUOrTeamMember(authToken, teamId);
      requireWebsocket(socket);

      // RESOLUTION
      const now = new Date();
      await r.table('Meeting')
        .getAll(teamId, {index: 'teamId'})
        .orderBy(r.desc('createdAt'))
        .nth(0)('id')
        .do((meetingId) => ({
          meetingId,
          meetingUpdates: r.table('AgendaItem')
            .getAll(teamId, {index: 'teamId'})
            .filter({isActive: true, isComplete: true})
            .map((doc) => doc('id'))
            .coerceTo('array')
            .do((agendaItemIds) => ({
              // delete any null actions
              deletedActions: r.table('Action')
                .getAll(r.args(agendaItemIds), {index: 'agendaId'})
                .filter((row) => row('content').eq(null))
                .delete(),
              deletedProjects: r.table('Project')
                .getAll(r.args(agendaItemIds), {index: 'agendaId'})
                .filter((row) => row('content').eq(null))
                .delete(),
              agendaItemIds
            }))
            .do((res) => {
              return {
                actions: r.table('Action')
                  .getAll(r.args(res('agendaItemIds')), {index: 'agendaId'})
                  // we still need to filter because this may occur before we delete them above (not guaranteed in sync)
                  .filter((row) => row('content').ne(null))
                  .map(row => row.merge({id: meetingId.add('::').add(row('id'))}))
                  .pluck('id', 'content', 'teamMemberId')
                  .coerceTo('array'),
                agendaItemsCompleted: res('agendaItemIds').count(),
                projects: r.table('Project')
                  .getAll(r.args(res('agendaItemIds')), {index: 'agendaId'})
                  .filter((row) => row('content').ne(null))
                  .map(row => row.merge({id: meetingId.add('::').add(row('id'))}))
                  .pluck('id', 'content', 'status', 'teamMemberId')
                  .coerceTo('array')
              };
            })
        }))
        .do((res) => {
          return r.table('Meeting').get(res('meetingId'))
            .update({
              actions: res('meetingUpdates')('actions').default([]),
              agendaItemsCompleted: res('meetingUpdates')('agendaItemsCompleted').default(0),
              endedAt: now,
              facilitator: `${authToken.sub}::${teamId}`,
              successExpression: makeSuccessExpression(),
              successStatement: makeSuccessStatement(),
              invitees: r.table('TeamMember')
                .getAll(teamId, {index: 'teamId'})
                .filter({isNotRemoved: true})
                .coerceTo('array')
                .map((teamMember) => ({
                  id: teamMember('id'),
                  present: r.branch(teamMember('isCheckedIn').eq(true), true, false)
                })),
              projects: res('meetingUpdates')('projects').default([]),

            }, {nonAtomic: true});
        });

      // send to summary
      await r.table('Team').get(teamId)
        .update({
          facilitatorPhase: SUMMARY,
          meetingPhase: SUMMARY,
          facilitatorPhaseItem: null,
          meetingPhaseItem: null,
        });

      // reset the meeting
      setTimeout(() => {
        r.table('Team').get(teamId)
          .update({
            facilitatorPhase: LOBBY,
            meetingPhase: LOBBY,
            meetingId: null,
            facilitatorPhaseItem: null,
            meetingPhaseItem: null,
            activeFacilitator: null
          })
          .do(() => {
            // flag agenda items as inactive (more or less deleted)
            return r.table('AgendaItem').getAll(teamId, {index: 'teamId'})
              .update({
                isActive: false
              });
          })
          .do(() => {
            // archive projects that are DONE
            return r.table('Project').getAll(teamId, {index: 'teamId'})
              .filter({status: DONE})
              .update({
                isArchived: true
              });
          })
          .do(() => {
            // shuffle the teamMember check in order, uncheck them in
            return r.table('TeamMember')
              .getAll(teamId, {index: 'teamId'})
              .sample(100000)
              .coerceTo('array')
              .do((arr) => arr.forEach((doc) => {
                  return r.table('TeamMember').get(doc('id'))
                    .update({
                      checkInOrder: arr.offsetsOf(doc).nth(0),
                      isCheckedIn: null
                    });
                })
              );
          })
          .run();
      }, 5000);
      return true;
    }
  },
  killMeeting: {
    type: GraphQLBoolean,
    description: 'Finish a meeting abruptly',
    args: {
      teamId: {
        type: new GraphQLNonNull(GraphQLID),
        description: 'The team that will be having the meeting'
      }
    },
    async resolve(source, {teamId}, {authToken, socket}) {
      const r = getRethink();

      // AUTH
      requireSUOrTeamMember(authToken, teamId);
      requireWebsocket(socket);

      // RESOLUTION
      // reset the meeting
      await r.table('Team').get(teamId)
        .update({
          facilitatorPhase: LOBBY,
          meetingPhase: LOBBY,
          meetingId: null,
          facilitatorPhaseItem: null,
          meetingPhaseItem: null,
          activeFacilitator: null
        });
      return true;
    }
  },
  addTeam: {
    type: GraphQLBoolean,
    description: 'Create a new team and add the first team member',
    args: {
      newTeam: {
        type: new GraphQLNonNull(TeamInput),
        description: 'The new team object with exactly 1 team member'
      },
      invitees: {
        type: new GraphQLList(new GraphQLNonNull(Invitee))
      },
      orgId: {
        type: new GraphQLNonNull(GraphQLID),
        description: 'The orgId of the new or existing team'
      },
      orgName: {
        type: GraphQLString,
        description: 'The name of the new team'
      },
      stripeToken: {
        type: GraphQLString,
        description: 'The CC info for the new team'
      }
    },
    async resolve(source, args, {authToken, socket}) {
      const r = getRethink();

      // AUTH
      const {orgId} = args.newTeam;
      const userId = authToken.sub;
      requireWebsocket(socket);
      await requireUserInOrg(userId, orgId);

      // VALIDATION
      const schema = makeAddTeamServerSchema({inviteEmails: [], teamMemberEmails: []});
      const {data: {invitees, newTeam}, errors} = schema(args);
      const teamId = newTeam.id;
      handleSchemaErrors(errors);
      await ensureUniqueId('Team', teamId);

      // RESOLUTION
      const authTokenObj = socket.getAuthToken();
      authTokenObj.tms = Array.isArray(authTokenObj.tms) ? authTokenObj.tms.concat(teamId) : [teamId];
      socket.setAuthToken(authTokenObj);
      await createTeamAndLeader(userId, newTeam);
      if (invitees && invitees.length) {
        const inviteeEmails = invitees.map((i) => i.email);
        const orgMemberInvitees = await r.table('User')
          .getAll(r.args(inviteeEmails), {index: 'email'})
          .pluck('id', 'email')
          // now that we know they exist in the system, see if they exist in the org
          .filter((row) => {
            // i wonder if this is inefficient in rethinkDB or if they cache the result?
            return r.table('Organization').get(orgId)('members').contains(row('id'))
          });
        const inOrgMembers = [];
        const outOfOrgEmails = [];
        for (let i = 0; i < invitees.length; i++) {
          const invitee = invitees[i];
          const isMember = orgMemberInvitees.find((i) => i.email === invitee.email);
          if (isMember) {
            inOrgMembers.push(invitee)
          } else {
            outOfOrgEmails.push(invitee.email);
          }
        }
        if (inOrgMembers.length > 0) {
          await asyncInviteTeam(authToken, teamId, invitees);
        }

        if (outOfOrgEmails.length) {
          // add a notification to the billing leaders
          const {userIds, inviter} = await r.table('Organization')
            .get(orgId)('orgUsers')
            .filter({
              role: BILLING_LEADER
            })
            .map((orgUser) => orgUser('id'))
            .do((userIds) => {
              return {
                userIds,
                inviter: r.table('User').get(userId).pluck('preferredName', 'id')
              }
            });
          const notificationIds = outOfOrgEmails.reduce((obj, email) => {
            obj[email] = shortid.generate();
            return obj;
          }, {});
          // send a new notification to each billing leader concerning each out-of-org invitee
          await r.expr(outOfOrgEmails)
            .forEach((invitee) => {
              return r.table('Notification')
                .insert({
                  id: r.expr(notificationIds)(invitee),
                  type: REQUEST_NEW_USER,
                  startAt: new Date(),
                  orgId,
                  userIds,
                  varList: [inviter.id, invitee, teamId]
                })
            });
          // TODO: send a toast???
        }
      }
      return true;
    }
  },
  createTeam: {
    // return the new JWT that has the new tms field
    type: GraphQLID,
    description: 'Create a new team and add the first team member. Called from the welcome wizard',
    args: {
      newTeam: {
        type: new GraphQLNonNull(TeamInput),
        description: 'The new team object with exactly 1 team member'
      }
    },
    async resolve(source, {newTeam}, {authToken}) {
      const r = getRethink();

      // AUTH
      const userId = requireAuth(authToken);
      const user = await r.table('User').get(userId).pluck('id', 'userOrgs', 'trialOrg');
      if (user.userOrgs && user.userOrgs.length > 0) {
        throw errorObj({_error: 'cannot use createTeam when already part of an org'});
      }
      if (user.trialOrg) {
        throw errorObj({_error: 'you have already created a team'})
      }

      // VALIDATION
      const schema = makeStep2Schema();
      const {data, errors} = schema(newTeam);
      handleSchemaErrors(errors);
      await ensureUniqueId('Team', newTeam.id);

      // RESOLUTION
      const now = new Date();
      const orgId = shortid.generate();
      const res = await r.branch(
        r.table('User').get(userId)('trialOrg'),
        null,
        r.table('User').get(userId).update({
          trialOrg: orgId,
          updatedAt: now
        }));
      if (!res) {
        throw errorObj({_error: 'Multiple calls detected'})
      }
      const validNewTeam = {...data, orgId};
      const expiresSoonId = shortid.generate();
      const orgName = `${user.preferredName}'s Org`;
      const {validUntil} = await createStripeOrg(orgId, orgName, true, userId, now);
      await r.table('Notification').insert({
        id: expiresSoonId,
        type: TRIAL_EXPIRES_SOON,
        startAt: new Date(now + ms('14d')),
        orgId,
        userIds: [userId],
        // trialExpiresAt
        varList: [validUntil]
      });
      const tms = await createTeamAndLeader(userId, validNewTeam, true);
      // Asynchronously create seed projects for team leader:
      // TODO: remove me after more
      addSeedProjects(authToken.sub, newTeam.id);
      return tmsSignToken(authToken, tms);
    }
  },
  changeFacilitator: {
    type: GraphQLBoolean,
    description: 'Change a facilitator while the meeting is in progress',
    args: {
      facilitatorId: {
        type: new GraphQLNonNull(GraphQLID),
        description: 'The facilitator teamMemberId for this meeting'
      }
    },
    async resolve(source, {facilitatorId}, {authToken, socket}) {
      const r = getRethink();

      // AUTH
      // facilitatorId is of format 'userId::teamId'
      const [, teamId] = facilitatorId.split('::');
      requireSUOrTeamMember(authToken, teamId);
      requireWebsocket(socket);

      // VALIDATION
      const facilitatorMembership = await r.table('TeamMember').get(facilitatorId);
      if (!facilitatorMembership || !facilitatorMembership.isNotRemoved) {
        throw errorObj({_error: 'facilitator is not active on that team'});
      }

      // RESOLUTION
      await r.table('Team').get(teamId).update({activeFacilitator: facilitatorId});
      return true;
    }
  },
  updateTeamName: {
    type: GraphQLBoolean,
    args: {
      updatedTeam: {
        type: new GraphQLNonNull(TeamInput),
        description: 'The input object containing the teamId and any modified fields'
      }
    },
    async resolve(source, {updatedTeam}, {authToken, socket}) {
      const r = getRethink();

      // AUTH
      requireSUOrTeamMember(authToken, updatedTeam.id);
      requireWebsocket(socket);

      // VALIDATION
      const schema = makeStep2Schema();
      const {errors, data: {id, name}} = schema(updatedTeam);
      handleSchemaErrors(errors);

      // RESOLUTION
      await r.table('Team').get(id).update({name});
      return true;
    }
  }
};


// The since-last-week mega query
// const updatedMeeting = await r.table('Meeting')
//   .getAll(teamId, {index: 'teamId'})
//   .orderBy(r.desc('createdAt'))
//   .limit(2)
//   .coerceTo('array')
//   .do((meetings) => {
//     // determine the oldVal baseline
//     // if this is the first meeting, diff from beginning of meeting
//     // else, diff from the end of the last meeting
//     return {
//       sinceTime: meetings.nth(1)('endedAt').default(meetings.nth(0)('createdAt')),
//       meetingId: meetings.nth(0)('id')
//     }
//   })
//   .do((res) => {
//     // create project diffs
//     return {
//       meetingId: res('meetingId'),
//       projectDiffs: r.table('Project')
//         .getAll(teamId, {index: 'teamId'})
//         .filter({isArchived: false})
//         .coerceTo('array')
//         .map((project) => {
//           // for each team project, get the old val and new val
//           return {
//             oldVal: r.table('ProjectHistory')
//               .between([project('id'), r.minval], [project('id'), res('sinceTime')], {index: 'projectIdUpdatedAt'})
//               .orderBy('projectIdUpdatedAt')
//               .coerceTo('array')
//               .nth(-1)
//               .without('id', 'projectId', 'updatedAt')
//               .default(null),
//             newVal: r.table('ProjectHistory')
//               .between([project('id'), res('sinceTime')], [project('id'), r.maxval], {index: 'projectIdUpdatedAt'})
//               .orderBy('projectIdUpdatedAt')
//               .coerceTo('array')
//               .nth(-1)
//               .without('id', 'projectId', 'updatedAt')
//               .default(null)
//           }
//         })
//         .do((fullDiffs) => {
//           // only grab the rows that have changed
//           return fullDiffs.filter((row) => row('newVal').ne(null))
//         })
//         .map((fullDiff) => {
//           return {
//             id: res('meetingId').add('::').add(fullDiff('newVal')('id')),
//             oldVal: fullDiff('oldVal'),
//             newVal: fullDiff('newVal')
//               .keys()
//               .filter((k) => {
//                 return fullDiff('oldVal').ne(null).and(fullDiff('oldVal')(k)).ne(fullDiff('newVal')(k))
//               })
//               .map((k) => [k, fullDiff('newVal')(k)])
//               .coerceTo('object')
//           }
//         })
//         .do((partialDiffs) => {
//           // if a project switch from 'active' to 'done' to 'active', remove it, too
//           return partialDiffs.filter((row) => row('newVal').ne({}))
//         })
//     }
//   })
//   .do((res) => {
//     // incorporate the newly created actions and endedAt
//     return {
//       meetingId: res('meetingId'),
//       meetingUpdates: {
//         actions: r.table('AgendaItem')
//           .getAll(teamId, {index: 'teamId'})
//           .filter({isActive: true})
//           .coerceTo('array')
//           .map((doc) => doc('id'))
//           .do((agendaItemIds) => {
//             return r.table('Action')
//               .getAll(r.args(agendaItemIds), {index: 'agendaId'})
//               .map(row => row.merge({id: res('meetingId').add('::').add(row('id'))}))
//               .pluck('id', 'content', 'teamMemberId')
//               .coerceTo('array')
//           }),
//         endedAt: now,
//         projects: res('projectDiffs'),
//         teamName: r.table('Team').get(teamId)('name'),
//         agendaItemsCompleted: r.table('AgendaItem')
//           .getAll(teamId, {index: 'teamId'})
//           .filter({isActive: true, isComplete: true})
//           .count()
//       }
//       // itemsCompleted: projectDiffs
//       //   .map(row => r.branch(row('newVal')('status').eq(DONE), 1, 0))
//       //   .reduce((left, right) => left.add(right)).default(0)
//     }
//   })
//   .do((res) => {
//     // add the updates to the meeting history
//     return r.table('Meeting').get(res('meetingId'))
//       .update(res('meetingUpdates'))
//   });


// r.db('actionDevelopment')
//   .table('Meeting')
//   .getAll('team123', {index: 'teamId'})
//   .orderBy(r.desc('createdAt'))
//   .nth(0)('id')
//   .do((meetingId) => {
//     return r.db('actionDevelopment')
//       .table('AgendaItem')
//       .getAll('team123', {index: 'teamId'})
//       .filter({isActive: true, isComplete: true})
//       .map((doc) => doc('id'))
//       .coerceTo('array')
//       .do((agendaItemIds) => {
//         return {
//             actions: r.db('actionDevelopment').table('Action')
//               .getAll(r.args(agendaItemIds), {index: 'agendaId'})
//               .map(row => row.merge({id: meetingId.add('::').add(row('id'))}))
//               .pluck('id', 'content', 'teamMemberId')
//               .coerceTo('array'),
//             agendaItemsCompleted: agendaItemIds.count(),
//             projects: r.db('actionDevelopment').table('Project')
//               .getAll(r.args(agendaItemIds), {index: 'agendaId'})
//               .map(row => row.merge({id: meetingId.add('::').add(row('id'))}))
//               .pluck('id', 'content', 'status', 'teamMemberId')
//               .coerceTo('array'),
//             teamName: r.db('actionDevelopment').table('Team').get('team123')('name'),
//           }
//       })
//   });

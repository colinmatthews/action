import {GraphQLID, GraphQLNonNull} from 'graphql';
import makeSubscribeIter from 'server/graphql/makeSubscribeIter';
import {requireSUOrTeamMember} from 'server/utils/authorization';
import RemoveSlackChannelPayload from 'server/graphql/types/RemoveSlackChannelPayload';

export default {
  type: new GraphQLNonNull(RemoveSlackChannelPayload),
  args: {
    teamId: {
      type: new GraphQLNonNull(GraphQLID)
    }
  },
  subscribe: (source, {teamId}, {authToken, socketId}) => {
    // AUTH
    requireSUOrTeamMember(authToken, teamId);

    // RESOLUTION
    const channelName = `slackChannelRemoved.${teamId}`;
    const filterFn = (value) => value.mutatorId !== socketId;
    return makeSubscribeIter(channelName, filterFn);
  }
};

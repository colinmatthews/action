import {GraphQLID, GraphQLNonNull} from 'graphql';
import makeSubscribeIter from 'server/graphql/makeSubscribeIter';
import {requireSUOrTeamMember} from 'server/utils/authorization';
import JoinIntegrationPayload from 'server/graphql/types/JoinIntegrationPayload';
import IntegrationService from 'server/graphql/types/IntegrationService';

export default {
  type: new GraphQLNonNull(JoinIntegrationPayload),
  args: {
    service: {
      type: new GraphQLNonNull(IntegrationService)
    },
    teamId: {
      type: new GraphQLNonNull(GraphQLID)
    }
  },
  subscribe: (source, {service, teamId}, {authToken, socketId}) => {
    // AUTH
    requireSUOrTeamMember(authToken, teamId);

    // RESOLUTION
    const channelName = `integrationJoined.${teamId}.${service}`;
    const filterFn = (value) => value.mutatorId !== socketId;
    return makeSubscribeIter(channelName, filterFn);
  }
};

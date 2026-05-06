import { ApolloClient, InMemoryCache, split, HttpLink } from "@apollo/client";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { getMainDefinition } from "@apollo/client/utilities";
import { createClient } from "graphql-ws";

const httpLink = new HttpLink({ uri: "http://localhost:8000/graphql" });

const wsLink = new GraphQLWsLink(
  createClient({ url: "ws://localhost:8000/graphql" })
);

// Subscriptions → WebSocket, other → HTTP
const splitLink = split(
  ({ query }) => {
    const def = getMainDefinition(query);
    return def.kind === "OperationDefinition" && def.operation === "subscription";
  },
  wsLink,
  httpLink
);

export const client = new ApolloClient({
  link: splitLink,
  cache: new InMemoryCache(),
});

import { ApolloClient, InMemoryCache, split } from "@apollo/client";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { getMainDefinition } from "@apollo/client/utilities";
import { createClient } from "graphql-ws";
import { createUploadLink } from "apollo-upload-client";

const uploadLink = createUploadLink({ 
  uri: "http://localhost:8000/graphql" 
});

const wsLink = new GraphQLWsLink(
  createClient({ url: "ws://localhost:8000/graphql" })
);

const splitLink = split(
  ({ query }) => {
    const def = getMainDefinition(query);
    return def.kind === "OperationDefinition" && def.operation === "subscription";
  },
  wsLink,
  uploadLink 
);

export const client = new ApolloClient({
  link: splitLink,
  cache: new InMemoryCache(),
});
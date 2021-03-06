// This file is mostly adapted from:
// https://github.com/zeit/next.js/blob/3949c82bdfe268f841178979800aa8e71bbf412c/examples/with-apollo/lib/initApollo.js

import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { onError } from '@apollo/client/link/error';
import crossFetch from 'cross-fetch';

import { getFromLocalStorage, LOCAL_STORAGE_KEYS } from './local-storage';
import { getGraphqlUrl } from './utils';

let apolloClient = null;

const fetch = async (url, options = {}) => {
  // Add headers to help the API identify origin of requests
  if (!process.browser) {
    options.headers = options.headers || {};
    options.headers['oc-env'] = process.env.OC_ENV;
    options.headers['oc-secret'] = process.env.OC_SECRET;
    options.headers['oc-application'] = process.env.OC_APPLICATION;
    options.headers['user-agent'] = 'opencollective-frontend/1.0 node-fetch/1.0';
  }

  // Start benchmarking if the request is server side
  const start = process.hrtime ? process.hrtime.bigint() : null;

  const result = await crossFetch(url, options);

  // Complete benchmark measure and log
  if (start && process.env.GRAPHQL_BENCHMARK) {
    const end = process.hrtime.bigint();
    const body = JSON.parse(options.body);
    if (body.operationName || body.variables) {
      console.log(
        '-> Fetched',
        body.operationName || 'anonymous GraphQL query',
        body.variables || {},
        `in ${Math.round(Number(end - start) / 1000000)}ms`,
      );
    }
  }

  return result;
};

function createClient(initialState, graphqlUrl) {
  const authLink = setContext((_, { headers }) => {
    const token = getFromLocalStorage(LOCAL_STORAGE_KEYS.ACCESS_TOKEN);
    if (token) {
      return {
        headers: {
          ...headers,
          authorization: `Bearer ${token}`,
        },
      };
    }
  });

  const cache = new InMemoryCache({
    dataIdFromObject: result =>
      `${result.__typename}:${result.id || result.name || result.slug || Math.floor(Math.random() * 1000000)}`,
    // Documentation:
    // https://www.apollographql.com/docs/react/data/fragments/#using-fragments-with-unions-and-interfaces
    possibleTypes: {
      Transaction: ['Expense', 'Order'],
      CollectiveInterface: ['Collective', 'Event', 'Project', 'Fund', 'Organization', 'User'],
      Account: ['Collective', 'Host', 'Individual', 'Fund', 'Project', 'Bot', 'Event', 'Organization'],
      AccountWithHost: ['Collective', 'Event', 'Fund', 'Project'],
      AccountWithContributions: ['Collective', 'Event', 'Fund', 'Project'],
    },
    // Documentation:
    // https://www.apollographql.com/docs/react/caching/cache-field-behavior/#merging-non-normalized-objects
    typePolicies: {
      Event: {
        fields: {
          tiers: {
            merge(existing, incoming) {
              return incoming;
            },
          },
        },
      },
    },
  });

  const errorLink = onError(({ graphQLErrors, networkError }) => {
    if (graphQLErrors) {
      graphQLErrors.map(error => {
        if (error) {
          const { message, locations, path } = error;
          console.error(`[GraphQL error]: Message: ${message}, Location: ${locations}, Path: ${path}`);
          return;
        }

        console.error('[GraphQL error]: Received null error');
      });
    }

    if (networkError) {
      console.error(`[Network error]: ${networkError}`);
    }
  });

  const apiV1Link = new HttpLink({
    uri: graphqlUrl || getGraphqlUrl('v1'),
    fetch,
  });
  const apiV2Link = new HttpLink({
    uri: graphqlUrl || getGraphqlUrl('v2'),
    fetch,
  });
  /** Depending on the value of the context.apiVersion we choose to use the link for the api
   * v1 or the api v2.
   */
  const httpLink = ApolloLink.split(
    operation => operation.getContext().apiVersion === '2', // Routes the query to the proper client
    apiV2Link,
    apiV1Link,
  );
  const link = ApolloLink.from([errorLink, authLink, httpLink]);

  return new ApolloClient({
    connectToDevTools: process.browser,
    ssrMode: !process.browser, // Disables forceFetch on the server (so queries are only run once)
    cache: cache.restore(initialState),
    ssrForceFetchDelay: 100, // See https://www.apollographql.com/docs/react/performance/server-side-rendering/#store-rehydration
    link,
  });
}

export default function initClient(initialState, graphqlUrl) {
  // Make sure to create a new client for every server-side request so that data
  // isn't shared between connections (which would be bad)
  if (!process.browser) {
    return createClient(initialState, graphqlUrl);
  }

  // Reuse client on the client-side
  if (!apolloClient) {
    apolloClient = createClient(initialState, graphqlUrl);
  }

  return apolloClient;
}

/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as auth from "../auth.js";
import type * as connections from "../connections.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as notion from "../notion.js";
import type * as notionApi from "../notionApi.js";
import type * as notionSchemas from "../notionSchemas.js";
import type * as origins from "../origins.js";
import type * as plaid from "../plaid.js";
import type * as plaidClient from "../plaidClient.js";
import type * as rules from "../rules.js";
import type * as rulesEngine from "../rulesEngine.js";
import type * as secureCompare from "../secureCompare.js";
import type * as sync from "../sync.js";
import type * as syncData from "../syncData.js";
import type * as syncInvestments from "../syncInvestments.js";
import type * as syncMappers from "../syncMappers.js";
import type * as syncPages from "../syncPages.js";
import type * as syncRun from "../syncRun.js";
import type * as syncTransactionWriter from "../syncTransactionWriter.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  auth: typeof auth;
  connections: typeof connections;
  crons: typeof crons;
  http: typeof http;
  notion: typeof notion;
  notionApi: typeof notionApi;
  notionSchemas: typeof notionSchemas;
  origins: typeof origins;
  plaid: typeof plaid;
  plaidClient: typeof plaidClient;
  rules: typeof rules;
  rulesEngine: typeof rulesEngine;
  secureCompare: typeof secureCompare;
  sync: typeof sync;
  syncData: typeof syncData;
  syncInvestments: typeof syncInvestments;
  syncMappers: typeof syncMappers;
  syncPages: typeof syncPages;
  syncRun: typeof syncRun;
  syncTransactionWriter: typeof syncTransactionWriter;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

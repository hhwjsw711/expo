/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as aiServices from "../aiServices.js";
import type * as auth from "../auth.js";
import type * as http from "../http.js";
import type * as phoneAuth from "../phoneAuth.js";
import type * as prompts from "../prompts.js";
import type * as r2Storage from "../r2Storage.js";
import type * as render from "../render.js";
import type * as revenuecat from "../revenuecat.js";
import type * as tasks from "../tasks.js";
import type * as twilioVerify from "../twilioVerify.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  aiServices: typeof aiServices;
  auth: typeof auth;
  http: typeof http;
  phoneAuth: typeof phoneAuth;
  prompts: typeof prompts;
  r2Storage: typeof r2Storage;
  render: typeof render;
  revenuecat: typeof revenuecat;
  tasks: typeof tasks;
  twilioVerify: typeof twilioVerify;
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

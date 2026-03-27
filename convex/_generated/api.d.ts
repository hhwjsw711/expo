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
import type * as r2Client from "../r2Client.js";
import type * as r2Storage from "../r2Storage.js";
import type * as render from "../render.js";
import type * as tasks from "../tasks.js";
import type * as twilioVerify from "../twilioVerify.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  aiServices: typeof aiServices;
  auth: typeof auth;
  http: typeof http;
  phoneAuth: typeof phoneAuth;
  prompts: typeof prompts;
  r2Client: typeof r2Client;
  r2Storage: typeof r2Storage;
  render: typeof render;
  tasks: typeof tasks;
  twilioVerify: typeof twilioVerify;
  users: typeof users;
}>;
declare const fullApiWithMounts: typeof fullApi;

export declare const api: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "internal">
>;

export declare const components: {
  r2: {
    lib: {
      deleteMetadata: FunctionReference<
        "mutation",
        "internal",
        { bucket: string; key: string },
        null
      >;
      deleteObject: FunctionReference<
        "mutation",
        "internal",
        {
          accessKeyId: string;
          bucket: string;
          endpoint: string;
          key: string;
          secretAccessKey: string;
        },
        null
      >;
      deleteR2Object: FunctionReference<
        "action",
        "internal",
        {
          accessKeyId: string;
          bucket: string;
          endpoint: string;
          key: string;
          secretAccessKey: string;
        },
        null
      >;
      getMetadata: FunctionReference<
        "query",
        "internal",
        {
          accessKeyId: string;
          bucket: string;
          endpoint: string;
          key: string;
          secretAccessKey: string;
        },
        {
          bucket: string;
          bucketLink: string;
          contentType?: string;
          key: string;
          lastModified: string;
          link: string;
          sha256?: string;
          size?: number;
          url: string;
        } | null
      >;
      listMetadata: FunctionReference<
        "query",
        "internal",
        {
          accessKeyId: string;
          bucket: string;
          cursor?: string;
          endpoint: string;
          limit?: number;
          secretAccessKey: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            bucket: string;
            bucketLink: string;
            contentType?: string;
            key: string;
            lastModified: string;
            link: string;
            sha256?: string;
            size?: number;
            url: string;
          }>;
          pageStatus?: null | "SplitRecommended" | "SplitRequired";
          splitCursor?: null | string;
        }
      >;
      store: FunctionReference<
        "action",
        "internal",
        {
          accessKeyId: string;
          bucket: string;
          endpoint: string;
          secretAccessKey: string;
          url: string;
        },
        any
      >;
      syncMetadata: FunctionReference<
        "action",
        "internal",
        {
          accessKeyId: string;
          bucket: string;
          endpoint: string;
          key: string;
          onComplete?: string;
          secretAccessKey: string;
        },
        null
      >;
      upsertMetadata: FunctionReference<
        "mutation",
        "internal",
        {
          bucket: string;
          contentType?: string;
          key: string;
          lastModified: string;
          link: string;
          sha256?: string;
          size?: number;
        },
        { isNew: boolean }
      >;
    };
  };
};

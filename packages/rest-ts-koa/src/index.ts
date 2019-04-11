/**
 * @module rest-ts-koa
 */

import { BadRequestHttpException } from "@senhung/http-exceptions";
import * as Koa from "koa";
import * as Router from "koa-router";

import {
  ApiDefinition,
  EndpointDefinition,
  buildGenericPathname,
  ExtractRuntimeType,
  deserialize,
  RemoveKey
} from "rest-ts-core";
import { Tuple2Dict } from "rest-ts-core";

/**
 * A promise of T or just T.
 */
type PromiseOrValue<T> = PromiseLike<T> | T;

/**
 * An koa Context with proper typings.
 */
interface TypedContext<T extends EndpointDefinition> extends Koa.Context {
  request: RemoveKey<Koa.Request, "body"> & {
    body: ExtractRuntimeType<T["body"]>;
  };
  params: Tuple2Dict<T["params"]>;
  query: ExtractRuntimeType<T["query"]>;
}

type NextFunction = () => Promise<any>;

export type RouteHandler<T extends EndpointDefinition> = (
  ctx: TypedContext<T>
) => PromiseOrValue<ExtractRuntimeType<T["response"]>>;

type RouterDefinition<T extends ApiDefinition> = {
  [K in keyof T]: RouteHandler<T[K]["def"]>
};

type BuiltRouter<T extends ApiDefinition> = {
  _def: RouterDefinition<T>;
};

interface ERROR_ALREADY_DEFINED {}

type RouteHandlerBuilder<
  Api extends ApiDefinition,
  Built extends RouterDefinition<any>,
  K extends keyof Api,
  RemainingKeys extends keyof Api
> = <H extends RouteHandler<Api[K]["def"]>>(
  handler: H
) => RouterBuilder<
  Api,
  Built & { [T in K]: H },
  RemainingKeys extends K ? never : RemainingKeys
>;

type RouterBuilder<
  T extends ApiDefinition,
  Built extends RouterDefinition<any>,
  RemainingKeys extends keyof T
> = {
  [K in RemainingKeys]: K extends keyof Built
    ? ERROR_ALREADY_DEFINED
    : RouteHandlerBuilder<T, Built, K, RemainingKeys>
} & {
  _def: Built;
};

/**
 * Create an koa router from an API definition.
 *
 * This is the preferred way to construct a router with rest-ts-koa. The builder pattern
 * allows you to catch many potential mistakes, such as a missing or extraneous definition, and
 * provides advanced type-checking of the handler code you write.
 *
 * This method accepts a type definition and a callback. You create the router using the builder
 * passed to the callback. This builder has one method for each endpoint of the API definition,
 * this method lets you write the implementation of that endpoint.
 *
 * For instance, if your API definition has the following endpoints:
 * ```ts
 * const myCustomAPI = defineAPI({
 *     listPublications: GET `/publications/${'category'}` .response(Publications),
 *     addPublication: POST `/publications` .body(Article) .response(PublicationResponse),
 *     removePublication: DELETE `/publications/${'id'}` .response(RemoveResponse)
 * });
 * ```
 *
 * Then you will implement the router like so:
 * ```ts
 * const router = buildRouter('/prefix', myCustomAPI, (builder) => builder
 *      .listPublications((ctx) => {
 *          return requestDatabaseForPublications({category: ctx.params.category})
 *      })
 *      .addPublication(async (ctx) => {
 *          const saved = await attemptSavePublication(ctx.request.body);
 *          return { id: saved.id };
 *      })
 *      .removePublication(async (ctx) => {
 *          await removePublication({ id: ctx.params.id });
 *          return 'OK';
 *      })
 * );
 * ```
 *
 * Attach your router to some koa server just like any other regular router:
 * ```ts
 * const app = koa();
 * app.use(router.routes());
 * ```
 *
 * @param apiDefinition The API definition you want to implement
 * @param cb A construction callback
 */
export function buildRouter<T extends ApiDefinition>(
  prefix: string,
  apiDefinition: T,
  cb: (builder: RouterBuilder<T, {}, keyof T>) => BuiltRouter<T>
) {
  const builder = {
    _def: {}
  } as any;
  Object.keys(apiDefinition).forEach(i => {
    builder[i] = (handler: RouteHandler<any>) => {
      builder._def[i] = handler;
      return builder;
    };
  });
  return createRouter(prefix, apiDefinition, cb(builder)._def);
}

/**
 * Alternate way to create a router.
 *
 * You should use {@link buildRouter} whenever possible. It provides more safety and plays better with IDEs than
 * this method.
 *
 * This function works similarly to {@link buildRouter} except that you pass a simple object hash and don't use a builder.
 * Each property of the hash is a route handler for the endpoint of the same name.
 *
 * Example:
 * ```ts
 * const router = createRouter('/prefix', myCustomAPI, {
 *      listPublications: (ctx) => {
 *          return requestDatabaseForPublications({category: ctx.params.category})
 *      },
 *      addPublication: async (ctx) => {
 *          const saved = await attemptSavePublication(ctx.request.body);
 *          return { id: saved.id };
 *      },
 *      removePublication: async (ctx) => {
 *          await removePublication({ id: ctx.params.id });
 *          return 'OK';
 *      }
 * );
 * ```
 * @param apiDefinition The API definition you want to implement.
 * @param hash The concrete implementation of the API.
 */
export function createRouter<T extends ApiDefinition>(
  prefix: string,
  apiDefinition: T,
  hash: RouterDefinition<T>
): Router {
  const router = new Router();
  if (prefix) {
    router.prefix(prefix);
  }
  Object.keys(apiDefinition).forEach(i => {
    const endpoint = apiDefinition[i];
    const def = endpoint.def;
    const path = buildGenericPathname(def);
    switch (endpoint.def.method) {
      case "GET":
        router.get(path, makeHandler(def, hash[i].bind(hash)));
        break;
      case "POST":
        router.post(path, makeHandler(def, hash[i].bind(hash)));
        break;
      case "PUT":
        router.put(path, makeHandler(def, hash[i].bind(hash)));
        break;
      case "PATCH":
        router.patch(path, makeHandler(def, hash[i].bind(hash)));
        break;
      case "DELETE":
        router.delete(path, makeHandler(def, hash[i].bind(hash)));
        break;
      /* istanbul ignore next: Guaranteed safe by the type system */
      default:
        ensureSwitchIsExhaustive(endpoint.def.method);
    }
  });
  return router;
}

function makeHandler<T extends EndpointDefinition>(
  def: T,
  fn: RouteHandler<T>
) {
  return (ctx: Router.RouterContext, next: NextFunction) => {
    (async () => {
      sanitizeIncomingRequest(def, ctx);
      const data = await Promise.resolve(fn(ctx));
      if (data !== undefined && !ctx.headerSent) {
        ctx.body = data;
      } else {
        next();
      }
    })().catch(next);
  };
}

function sanitizeIncomingRequest(
  def: EndpointDefinition,
  ctx: Router.RouterContext
) {
  if (ctx.request.body != null) {
    try {
      ctx.request.body =
        def.body == null ? null : deserialize(def.body, ctx.request.body);
    } catch (e) {
      throw new BadRequestHttpException(e);
    }
  }
  if (ctx.request.query != null) {
    try {
      ctx.request.query =
        def.query == null ? null : deserialize(def.query, ctx.query);
    } catch (e) {
      throw new BadRequestHttpException(e);
    }
  }
}

/* istanbul ignore next */
function ensureSwitchIsExhaustive(_t: never) {}

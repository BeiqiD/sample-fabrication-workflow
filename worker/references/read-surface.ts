import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { isReferenceTarget, MAX_REFERENCE_RESOLUTION_TARGETS, type ResolveReferencesInput } from "../../shared/reference-types";
import { ReferenceResolutionInputError } from "./read-resolver";
import { ReferenceChildrenInputError } from "./read-children";
import { ReferenceSearchInputError } from "./read-search";
import type { ReferenceReadService } from "./read-service";

type ActorBindings<Bindings extends object> = {Bindings:Bindings;Variables:{userEmail:string}};
async function body<Bindings extends object>(c:Context<ActorBindings<Bindings>>):Promise<unknown> {
  try {return await c.req.json<unknown>();}
  catch {throw new HTTPException(400,{message:"A valid JSON request body is required"});}
}
async function referenceReadCall<T>(work:()=>Promise<T>):Promise<T> {
  try {return await work();}
  catch(error) {
    if(error instanceof ReferenceResolutionInputError || error instanceof ReferenceChildrenInputError || error instanceof ReferenceSearchInputError)
      throw new HTTPException(400,{message:error.message});
    throw error;
  }
}
export function createReferenceReadHandlers<Bindings extends object>(selectService:(request:Request,bindings:Bindings)=>ReferenceReadService) {
  const requests = new WeakMap<Context<ActorBindings<Bindings>>,Request>();
  const originalRequest = (c:Context<ActorBindings<Bindings>>) => {
    const request=requests.get(c);if(!request)throw new Error("Reference request admission is unavailable");return request;
  };
  const captureIngressRequest:MiddlewareHandler<ActorBindings<Bindings>> = async(c,next) => {
    requests.set(c,c.req.raw);try {await next();}finally {requests.delete(c);}
  };
  return {
    captureIngressRequest,
    async resolve(c:Context<ActorBindings<Bindings>>) {
      const input=await body(c);
      if(!input || typeof input!=="object" || !Array.isArray((input as Partial<ResolveReferencesInput>).targets))
        throw new HTTPException(400,{message:"Reference targets are required"});
      const targets=(input as Partial<ResolveReferencesInput>).targets!;
      if(targets.length<1 || targets.length>MAX_REFERENCE_RESOLUTION_TARGETS)
        throw new HTTPException(400,{message:`Between 1 and ${MAX_REFERENCE_RESOLUTION_TARGETS} reference targets are required`});
      if(!targets.every(target=>isReferenceTarget(target)&&target.id.trim()===target.id))
        throw new HTTPException(400,{message:"Every reference target needs a known type and valid stable ID"});
      return c.json(await referenceReadCall(()=>selectService(originalRequest(c),c.env).resolve(targets,c.get("userEmail"))));
    },
    async children(c:Context<ActorBindings<Bindings>>) {
      const input=await body(c);
      return c.json(await referenceReadCall(()=>selectService(originalRequest(c),c.env).children(input,c.get("userEmail"))));
    },
    async search(c:Context<ActorBindings<Bindings>>) {
      const input=await body(c);
      return c.json(await referenceReadCall(()=>selectService(originalRequest(c),c.env).search(input,c.get("userEmail"))));
    },
  };
}
export function createReferenceReadSurface<Bindings extends object>(selectService:(request:Request,bindings:Bindings)=>ReferenceReadService) {
  const routes=new Hono<ActorBindings<Bindings>>(),handlers=createReferenceReadHandlers(selectService);
  routes.post("/references/resolve",handlers.captureIngressRequest,handlers.resolve);
  routes.post("/references/children",handlers.captureIngressRequest,handlers.children);
  routes.post("/references/search",handlers.captureIngressRequest,handlers.search);
  return routes;
}

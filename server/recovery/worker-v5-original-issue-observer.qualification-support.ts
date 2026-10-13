/** Test-isolate source only. The actual production handler authenticates every
 * business request; this observer never creates an actor, job or SQL result.
 * Only exact original native query acknowledgements may be held. */
export const WORKER_V5_ORIGINAL_ISSUE_OBSERVER_SOURCE = String.raw`
import original from './index';
let live,gate,originalAdministrator;
const observedBodies=new WeakMap();
const statements=new WeakMap();
const trace={nativeGet:0,nativeHead:0,nativePut:0,nativeDelete:0,readers:0,
  originalCancelCalls:0,originalCancelAcknowledged:0,originalCancelRejected:0,
  originalReaderClosedAcknowledged:0,originalReaderClosedRejected:0,actorRevoked:false};
const require=(value,reason)=>{if(!value)throw new Error('worker_v5_original_observer_'+reason);};
function originalBody(body){
  if(observedBodies.has(body))return observedBodies.get(body);
  const observed=new Proxy(body,{get(target,key){
    const value=Reflect.get(target,key,target);
    if(key!=='getReader')return typeof value==='function'?value.bind(target):value;
    return (...args)=>{
      const reader=Reflect.apply(value,target,args);trace.readers++;
      Promise.resolve(reader.closed).then(()=>trace.originalReaderClosedAcknowledged++,()=>trace.originalReaderClosedRejected++);
      let firstCancel;
      return new Proxy(reader,{get(owner,method){
        const operation=Reflect.get(owner,method,owner);
        if(method==='cancel')return (...input)=>{
          trace.originalCancelCalls++;
          if(firstCancel===undefined){
            firstCancel=Reflect.apply(operation,owner,input);
            Promise.resolve(firstCancel).then(()=>trace.originalCancelAcknowledged++,()=>trace.originalCancelRejected++);
          }
          return firstCancel;
        };
        return typeof operation==='function'?operation.bind(owner):operation;
      }});
    };
  }});
  observedBodies.set(body,observed);return observed;
}
function nativeBucket(bucket){
  return new Proxy(bucket,{get(target,key){
    const method=Reflect.get(target,key,target);
    if(key!=='get'&&key!=='head'&&key!=='put'&&key!=='delete')return typeof method==='function'?method.bind(target):method;
    return (...args)=>{
      const counter=key==='get'?'nativeGet':key==='head'?'nativeHead':key==='put'?'nativePut':'nativeDelete';
      trace[counter]++;
      const originalPromise=Reflect.apply(method,target,args);
      if(key!=='get')return originalPromise;
      return Promise.resolve(originalPromise).then(value=>value===null?null:new Proxy(value,{get(object,name){
        const property=Reflect.get(object,name,object);
        return name==='body'?originalBody(property):typeof property==='function'?property.bind(object):property;
      }}));
    };
  }});
}
function nativeFailure(operation,error){
  const name=error&&['Error','TypeError','RangeError','DataCloneError'].includes(error.name)?error.name:'NativeError';
  const message=error&&typeof error.message==='string'?error.message:'';
  const code=/\b(SQLITE_ERROR|SQLITE_AUTH|SQLITE_NOMEM|SQLITE_CONSTRAINT|SQLITE_BUSY|SQLITE_LOCKED|SQLITE_CORRUPT|SQLITE_NOTADB|SQLITE_IOERR|SQLITE_READONLY|SQLITE_FULL|D1_ERROR|D1_TYPE_ERROR|D1_EXEC_ERROR|D1_COLUMN_NOTFOUND|D1_SESSION_ERROR)\b/.exec(message)?.[1]??(message.includes('Illegal invocation')?'ILLEGAL_INVOCATION':'CODE_UNAVAILABLE');
  console.error('Original native observer failure',{operation,kind:name,code}); // no SQL/bindings/headers/identity
}
function selectedSql(sql){
  if(!gate||gate.entered||gate.released)return false;
  if(gate.kind==='namespace-actor')return /^SELECT\s+\*\s+FROM\s+system_recovery_jobs\s+WHERE\s+id\s*=\s*\?\s*$/i.test(sql.trim());
  if(gate.kind==='profile-actor')return /SELECT 1 FROM storage_profiles p JOIN storage_profile_runtime r/.test(sql);
  return gate.kind==='held-original-ack'&&trace.readers>0&&/FROM file_location_holds h JOIN file_locations l/.test(sql);
}
function selected(sql,method,stack){
  if(!gate||gate.entered||method!=='first')return false;
  if(gate.kind==='namespace-actor')return /^SELECT\s+\*\s+FROM\s+system_recovery_jobs\s+WHERE\s+id\s*=\s*\?\s*$/i.test(sql.trim())
    &&stack.includes('assertPrivateKeyNamespace');
  if(gate.kind==='profile-actor')return /SELECT 1 FROM storage_profiles p JOIN storage_profile_runtime r/.test(sql);
  return gate.kind==='held-original-ack'&&trace.readers>0&&/FROM file_location_holds h JOIN file_locations l/.test(sql);
}
function nativeStatement(statement,sql){
  const proxy=new Proxy(statement,{get(target,key){
    const value=Reflect.get(target,key,target);
    if(key==='bind')return (...args)=>nativeStatement(Reflect.apply(value,target,args),sql);
    if(key!=='first')return typeof value==='function'?value.bind(target):value;
    return (...args)=>{
      const matching=selected(sql,key,new Error().stack??'');
      let originalPromise;
      try{originalPromise=Reflect.apply(value,target,args);}catch(error){nativeFailure('selected-first',error);throw error;}
      void Promise.resolve(originalPromise).catch(error=>nativeFailure('selected-first',error));
      if(!matching)return originalPromise;
      // Reserve the single original identity synchronously before the first await.
      const selectedGate=gate;selectedGate.entered=true;selectedGate.enteredAt=Date.now();
      return Promise.resolve(originalPromise).then(async value=>{
        selectedGate.originalAcknowledged=true;
        await selectedGate.pending;
        selectedGate.returnedAt=Date.now();
        return value; // EXACT native value, never a manufactured authority row.
      });
    };
  }});
  statements.set(proxy,statement);return proxy;
}
function nativeDatabase(database){
  return new Proxy(database,{get(target,key){
    const value=Reflect.get(target,key,target);
    if(key==='prepare')return sql=>{
      const originalStatement=Reflect.apply(value,target,[sql]);
      return selectedSql(sql)?nativeStatement(originalStatement,sql):originalStatement;
    };
    if(key==='withSession')return (...args)=>{
      const originalSession=Reflect.apply(value,target,args);
      return gate&&!gate.released?nativeDatabase(originalSession):originalSession;
    };
    if(key==='batch')return values=>{
      // Preserve the SAME native array and statement receivers unless this
      // exact batch actually contains a selected first() observer statement.
      const selected=values.some(statement=>statements.has(statement));
      const originalValues=selected?values.map(statement=>statements.get(statement)??statement):values;
      let originalPromise;
      try{originalPromise=Reflect.apply(value,target,[originalValues]);}catch(error){nativeFailure('native-batch',error);throw error;}
      void Promise.resolve(originalPromise).catch(error=>nativeFailure('native-batch',error));return originalPromise;
    };
    return typeof value==='function'?value.bind(target):value;
  }});
}
function environment(bindings){
  if(live)return live;
  require(typeof bindings.V5_QUALIFICATION_CONTROL_NONCE==='string','private_control_binding');
  originalAdministrator=bindings.SYSTEM_ADMIN_EMAILS;
  live={...bindings,DB:nativeDatabase(bindings.DB),ASSETS:nativeBucket(bindings.ASSETS)};
  if(bindings.RECOVERY_DB)live.RECOVERY_DB=nativeDatabase(bindings.RECOVERY_DB);
  return live;
}
async function control(request,env){
  require(request.headers.get('x-original-native-control')===env.V5_QUALIFICATION_CONTROL_NONCE,'private_control');
  const action=new URL(request.url).pathname.slice('/__original_native_qualification/'.length);
  if(action==='stats')return Response.json({...trace,gate:gate?{
    kind:gate.kind,entered:gate.entered,originalAcknowledged:gate.originalAcknowledged,released:gate.released,
    enteredAt:gate.enteredAt??null,returnedAt:gate.returnedAt??null}:null});
  if(action==='arm'){
    require(!gate||gate.released,'old_original_gate_unsettled');const kind=await request.text();
    require(['namespace-actor','profile-actor','held-original-ack'].includes(kind),'closed_gate_selection');
    for(const name of Object.keys(trace))trace[name]=name==='actorRevoked'?false:0;
    let release;const pending=new Promise(resolve=>{release=resolve;});
    gate={kind,pending,release,entered:false,originalAcknowledged:false,released:false};return Response.json({armed:true});
  }
  if(action==='revoke-administrator'){env.SYSTEM_ADMIN_EMAILS='';trace.actorRevoked=true;return Response.json({actualEnvironmentPolicyRevoked:true});}
  if(action==='release'||action==='stop-observer'){
    if(action==='stop-observer'){env.SYSTEM_ADMIN_EMAILS='';trace.actorRevoked=true;}
    if(gate&&!gate.released){gate.released=true;gate.release();}
    return Response.json({originalGateReleased:true});
  }
  if(action==='restore-administrator'){
    require(!gate||gate.released,'original_gate_unsettled');env.SYSTEM_ADMIN_EMAILS=originalAdministrator;
    return Response.json({actualEnvironmentPolicyRestored:true});
  }
  return new Response(null,{status:404});
}
export default {
  fetch(request,bindings,context){const env=environment(bindings);
    if(new URL(request.url).pathname.startsWith('/__original_native_qualification/'))return control(request,env);
    return original.fetch(request,env,context);
  },
  scheduled(event,bindings,context){return original.scheduled(event,environment(bindings),context);},
};
`;

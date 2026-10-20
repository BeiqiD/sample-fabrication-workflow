import { verifyDeploymentBootstrap } from "./lib/cloudflare-bootstrap.mjs";

await verifyDeploymentBootstrap(process.cwd());
console.log("Built Worker and migration deployment identities agree.");

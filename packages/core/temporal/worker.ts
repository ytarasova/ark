import { Worker, NativeConnection } from "@temporalio/worker";
import { loadAppConfig } from "../config.js";
import { AppContext } from "../app.js";
import { depsFromApp } from "../services/deps.js";
import * as actStartSession from "./activities/start-session.js";
import * as actResolveCompute from "./activities/resolve-compute.js";
import * as actProvision from "./activities/provision-compute.js";
import * as actDispatch from "./activities/dispatch-stage.js";
import * as actAwait from "./activities/await-stage-completion.js";
import * as actAction from "./activities/execute-action.js";
import * as actVerify from "./activities/run-verification.js";
import * as actProjSession from "./activities/project-session.js";
import * as actProjStage from "./activities/project-stage.js";
import * as activities from "./activities/index.js";

async function main() {
  const config = await loadAppConfig();

  const app = new AppContext(config);
  await app.boot();
  const deps = depsFromApp(app);

  actStartSession.injectDeps(deps);
  actResolveCompute.injectDeps(deps);
  actProvision.injectDeps(deps);
  actDispatch.injectDeps(deps);
  actAwait.injectDeps(deps);
  actAction.injectDeps(deps);
  actVerify.injectDeps(deps);
  actProjSession.injectDeps(deps);
  actProjStage.injectDeps(deps);

  const connection = await NativeConnection.connect({ address: config.temporal.serverUrl });

  const queues =
    config.temporal.taskQueueAssignments.length > 0
      ? config.temporal.taskQueueAssignments
      : [`ark.${config.authSection.defaultTenant ?? "default"}.stages`];

  for (const taskQueue of queues) {
    const worker = await Worker.create({
      connection,
      namespace: config.temporal.namespace,
      taskQueue,
      workflowsPath: new URL("./workflows/session-workflow.js", import.meta.url).pathname,
      activities,
    });
    await worker.run();
  }
}

main().catch((err) => {
  console.error("Temporal worker fatal:", err);
  process.exit(1);
});

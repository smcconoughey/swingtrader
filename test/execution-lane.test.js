import test from "node:test";
import assert from "node:assert/strict";

import { ExecutionLane } from "../execution-lane.js";

test("management work skips a busy broker lane", async () => {
  const lane = new ExecutionLane();
  let releaseFirst;
  const blocker = new Promise(resolve => { releaseFirst = resolve; });
  const first = lane.run(async () => {
    await blocker;
    return "done";
  });

  await Promise.resolve();
  let ran = false;
  const skipped = await lane.run(async () => { ran = true; }, { skipIfBusy: true });
  assert.deepEqual(skipped, { skipped: true });
  assert.equal(ran, false);

  releaseFirst();
  assert.equal(await first, "done");
});

test("broker commits queue and execute serially", async () => {
  const lane = new ExecutionLane();
  const order = [];
  let releaseFirst;
  let markStarted;
  const blocker = new Promise(resolve => { releaseFirst = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });

  const first = lane.run(async () => {
    order.push("first:start");
    markStarted();
    await blocker;
    order.push("first:end");
  });
  const second = lane.run(async () => { order.push("second"); });
  await started;
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

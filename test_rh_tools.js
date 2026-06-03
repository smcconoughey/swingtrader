import { robinhood } from './robinhood.js';

async function test() {
  const rhOk = await robinhood.init();
  if (rhOk) {
    const pos = await robinhood.getPositions();
    console.log("Positions:", JSON.stringify(pos, null, 2));
  } else {
    console.log("Not connected");
  }
}
test();

// WHAT TO BUY (PLAB): this month's money split among the target holdings — water filling (the most underweight first,
// every holding bought ending at the same value / weight ratio), sales on request, minimum trade, cost per trade, whole
// units, positions outside the target, the gain realised by sales (qmath.js buyPlan). Hand-computed cases.
//   node test/rebalance.test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Q = require("../public/terminal/qmath.js");

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${c ? "" : "  " + x}`); c ? pass++ : fail++; };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const tr = (p) => p.rows.map((r) => Math.round(r.trade * 100) / 100);

// 60 / 30 / 10 target; held 6,000 / 2,000 / 2,000 (60 / 20 / 20 %); €1,000 to invest
let p = Q.buyPlan({ items: [{ w: 60, v: 6000, px: 100 }, { w: 30, v: 2000, px: 50 }, { w: 10, v: 2000, px: 10 }], cash: 1000 });
ok("the money goes to the most underweight first: all €1,000 to the 30 % holding (20 % now)", tr(p).join() === "0,1000,0" && near(p.spare, 0) && p.nBuy === 1, tr(p).join());
ok("…it ends at the same value / weight as the 60 % one (3,000 / 0.3 = 6,000 / 0.6); nothing sold", near(p.rows[1].value / 0.3, p.rows[0].value / 0.6) && p.nSell === 0 && p.sold === 0);
ok("…gaps before and after: largest is the 10 % holding, +10 → +8.18 pts (only sales would close it)", p.maxBefore.i === 2 && near(p.maxBefore.d, 0.1) && p.maxAfter.i === 2 && near(p.maxAfter.d, 2000 / 11000 - 0.1));
// enough money to reach every target: the targets exactly
p = Q.buyPlan({ items: [{ w: 60, v: 6000 }, { w: 30, v: 2000 }, { w: 10, v: 2000 }], cash: 10000 });
ok("enough money for every gap (targets at 20,000: 12,000 / 6,000 / 2,000): each bought up to it", tr(p).join() === "6000,4000,0" && near(p.rows[0].after, 0.6) && near(p.rows[1].after, 0.3) && near(p.rows[2].after, 0.1));
p = Q.buyPlan({ items: [{ w: 60, v: 6000 }, { w: 30, v: 2000 }, { w: 10, v: 2000 }], cash: 12000 });
ok("…more than enough: the rest by the weights, all at their targets (13,200 / 6,600 / 2,200)", tr(p).join() === "7200,4600,200" && near(p.maxAfter.d, 0, 1e-9));
p = Q.buyPlan({ items: [{ w: 70, v: 0 }, { w: 30, v: 0 }], cash: 500 });
ok("nothing held yet: split by the weights (350 / 150)", tr(p).join() === "350,150" && Number.isNaN(p.rows[0].now) && near(p.rows[0].after, 0.7));

// sales on request: the overweight one down to its target, then the money spread
p = Q.buyPlan({ items: [{ w: 60, v: 6000, px: 100 }, { w: 30, v: 2000, px: 50 }, { w: 10, v: 2000, px: 10, avg: 8 }], cash: 1000, sell: true });
ok("also sell: the 10 % holding sold down to 1,100 (−900), the money (1,000 + 900) to the others → exact weights", tr(p).join() === "600,1300,-900" && near(p.rows[2].after, 0.1) && near(p.spare, 0, 1e-6) && p.nSell === 1 && near(p.sold, 900));
ok("…the gain realised: 90 units sold at 10 bought at 8 → +180", near(p.gainSold, 180) && p.gainsKnown);
p = Q.buyPlan({ items: [{ w: 100, v: 1000, px: 10 }, { w: 0, v: 500, px: 5, avg: null, buy: false }], cash: 0, sell: true });
ok("…a position outside the target: sold entirely, never bought; its gain unknown without an average cost", tr(p).join() === "500,-500" && p.gainSold === null && !p.gainsKnown);
p = Q.buyPlan({ items: [{ w: 100, v: 1000, px: 10 }, { w: 0, v: 500, px: 5, buy: false }], cash: 300 });
ok("…without sales it is kept and counted in the total, never bought", tr(p).join() === "300,0" && near(p.rows[1].after, 500 / 1800) && near(p.rows[0].after, 1300 / 1800));

// smallest trade and cost per trade
p = Q.buyPlan({ items: [{ w: 50, v: 950 }, { w: 50, v: 1000 }], cash: 100, minTrade: 60 });
ok("smallest trade €60: the 75 / 25 split would buy 25 below it → all 100 to the most underweight", tr(p).join() === "100,0", tr(p).join());
p = Q.buyPlan({ items: [{ w: 50, v: 0 }, { w: 50, v: 0 }], cash: 102, cost: 1 });
ok("cost €1 a trade: 2 buys → €100 invested, 50 each, costs 2", tr(p).join() === "50,50" && p.costs === 2 && near(p.spare, 0));
p = Q.buyPlan({ items: [{ w: 50, v: 0 }, { w: 50, v: 0 }], cash: 30, cost: 1, minTrade: 20 });
ok("…cost and minimum together: €30 cannot make two trades of €20 → one of €29 (a tie: either)", tr(p).sort().join() === "0,29" && p.costs === 1 && near(p.spare, 0), tr(p).join());

// whole units
p = Q.buyPlan({ items: [{ w: 60, v: 0, px: 97 }, { w: 40, v: 0, px: 33 }], cash: 500, whole: true, cost: 1 });
ok("whole units: whole numbers of units, money not spent < the cheapest unit + its cost", p.rows.every((r) => r.units == null || Number.isInteger(Math.round(r.units * 1e9) / 1e9)) && p.spare >= 0 && p.spare < 33 + 1 && near(p.bought + p.costs + p.spare, 500), JSON.stringify([tr(p), p.spare]));
ok("…still close to the weights (each within one unit's value)", Math.abs(p.rows[0].value - 0.6 * (p.bought)) <= 97 && Math.abs(p.rows[1].value - 0.4 * p.bought) <= 97);
p = Q.buyPlan({ items: [{ w: 100, v: 0, px: 700 }], cash: 500, whole: true });
ok("…a unit dearer than the money: nothing bought, all left over", tr(p).join() === "0" && near(p.spare, 500));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * 回合推进。
 *
 * 只做一件事：在一份**按先攻排好**的参战者列表上，找出下一个还站着的人。
 *
 * 倒地的参战者会被跳过 —— 跟《博德之门 3》一样，尸体不占回合，
 * 否则每轮都要在死人身上停一下、白刷一次行动经济。
 * 跨过列表首尾时报告轮次变化，交给调用方去改 `round`。
 *
 * 这里是纯函数：不碰 DOM、不碰状态，所以可以直接跑测试。
 */

/** 还站着的参战者的下标 */
export function standingIndexes(list) {
  const out = [];
  (list || []).forEach((c, i) => { if (c && !c.defeated) out.push(i); });
  return out;
}

/** 还有没有人站着 */
export function hasStanding(list) {
  return standingIndexes(list).length > 0;
}

/**
 * 从 `from` 出发，朝 `dir` 方向找下一个还站着的参战者。
 *
 * @param {Array} list  按先攻排好的参战者
 * @param {number} from 当前下标
 * @param {number} dir  +1 下一位 / −1 上一位
 * @returns {{index:number, roundDelta:number, skipped:number}|null}
 *          没人还站着、或者列表为空时返回 null（调用方保持原地不动）
 */
export function stepTurnIndex(list, from, dir = 1) {
  const n = (list || []).length;
  if (!n) return null;
  if (!hasStanding(list)) return null;

  const step = dir < 0 ? -1 : 1;
  let index = Number.isInteger(from) ? from : 0;
  let roundDelta = 0;
  let skipped = 0;

  // 绕一圈必然能碰到所有位置，所以 n 步之内一定找得到；n*2 只是保险丝
  for (let hops = 1; hops <= n * 2; hops++) {
    index += step;
    if (index >= n) { index = 0; roundDelta += 1; }
    else if (index < 0) { index = n - 1; roundDelta -= 1; }

    if (!list[index]?.defeated) return { index, roundDelta, skipped };
    skipped++;
  }
  return null;
}

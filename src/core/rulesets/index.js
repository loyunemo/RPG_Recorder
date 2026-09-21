/**
 * 规则集注册表。
 * 新增一套规则只需在这里加一行，界面会自动获得对应的角色卡与判定面板。
 */

import coc7 from './coc7.js';
import dnd5e from './dnd5e.js';
import daggerheart from './daggerheart.js';
import huazhu from './huazhu/index.js';

export const RULESETS = { coc7, dnd5e, daggerheart, huazhu };

export const RULESET_LIST = [coc7, dnd5e, daggerheart, huazhu];

export function getRuleset(id) {
  return RULESETS[id] || coc7;
}

export default RULESETS;

/**
 * 角色数据读写的小工具，供角色卡与战斗追踪器共用。
 * 三套规则把「当前生命值」存在不同字段里，这里统一收口。
 */

/**
 * 把「当前值」写回对应系统的存储位置。
 *
 * 四套规则把当前生命值存在完全不同的地方，必须逐一套准：
 *   COC    data.state.hp
 *   DND    data.combat.hp
 *   匕首心  data.hpMarked（记录「已标记几格」，当前值要反算）
 *   华渚   同匕首心
 * 判断依据是字段是否存在，而不是规则 id —— 这样玩家自建的旧角色卡也能兼容。
 */
export function setTrackValue(data, key, current) {
  switch (key) {
    case 'hp':
      if (data.state) data.state.hp = current;
      else if (data.combat) data.combat.hp = current;
      else data.hpMarked = Math.max(0, (data.hpMax ?? 6) - current);
      break;
    case 'mp':
      if (data.state) data.state.mp = current;
      break;
    case 'san':
      if (data.state) data.state.san = current;
      break;
    case 'luck':
      if (data.state) data.state.luck = current;
      else if ('luck' in data) data.luck = current;
      break;
    case 'tempHp':
      if (data.combat) data.combat.tempHp = current;
      break;
    case 'stress':
      data.stressMarked = Math.max(0, (data.stressMax ?? 6) - current);
      break;
    case 'armorSlots':
      data.armorMarked = Math.max(0, (data.armorSlotsMax ?? 0) - current);
      break;
    case 'hope': data.hope = current; break;
    case 'fear': data.fear = current; break;
    default: break;
  }
}

/** 取某个资源轨道的当前值 */
export function getTrack(rs, data, key = 'hp') {
  const d = rs.derive(data);
  return d.tracks.find(t => t.key === key) || null;
}

/**
 * 从角色卡生成一个战斗参战者。
 * @param {object} rs 规则集
 * @param {object} char 角色对象
 */
export function combatantFromCharacter(rs, char) {
  const d = rs.derive(char.data);
  const hp = d.tracks.find(t => t.key === 'hp');
  const stat = (k) => d.stats.find(s => s.key === k)?.value ?? null;

  let defenseLabel = '—';
  let defense = null;
  if (rs.id === 'dnd5e') { defenseLabel = 'AC'; defense = stat('ac'); }
  else if (rs.id === 'daggerheart') { defenseLabel = '闪避'; defense = d.evasion; }
  else if (rs.id === 'coc7') { defenseLabel = 'DEX'; defense = char.data.attributes?.dex ?? null; }

  return {
    id: `cb_${Math.random().toString(36).slice(2, 9)}`,
    name: char.name,
    kind: 'pc',
    refId: char.id,
    initiative: null,
    hp: hp?.current ?? 0,
    maxHp: hp?.max ?? 0,
    defenseLabel,
    defense,
    conditions: '',
    note: '',
    defeated: false,
  };
}

/** 自由参战者（杂兵、临时 NPC） */
export function blankCombatant(name = '新参战者') {
  return {
    id: `cb_${Math.random().toString(36).slice(2, 9)}`,
    name,
    kind: 'npc',
    refId: null,
    initiative: null,
    hp: 10,
    maxHp: 10,
    defenseLabel: 'AC',
    defense: 12,
    conditions: '',
    note: '',
    defeated: false,
  };
}

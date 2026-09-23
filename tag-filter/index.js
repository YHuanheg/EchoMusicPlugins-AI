/**
 * 插件标签筛选 —— EchoMusic 插件（id: tag-filter）
 *
 * 作用：在「设置 → 插件」（插件管理）面板里注入一条筛选条，
 *      把面板里所有插件的**标签**与**状态**聚合成分组条件供点选，实时过滤卡片列表。
 *
 * 为什么是「读宿主 DOM + 隐藏卡片」，而不是驱动宿主的搜索框：
 *   ① 宿主的搜索框只做文本匹配，表达不了「同时满足多个标签」与状态维度；
 *   ② 卡片上的标签与状态本来就是宿主渲染出来的，直接读它最准，
 *      而且「已安装」与「在线插件」两个视图结构一致，一套代码全覆盖；
 *   ③ 不需要任何新的宿主 API，也就不会因为宿主版本收紧能力而失效。
 *
 * 宿主 DOM 契约（2026-09-23 用 app.asar 逐字节核验，EchoMusic v2.3.2-beta.6）：
 *   .plugin-content                插件管理页的内容容器（两种视图共用一个）
 *   .plugin-card-grid              卡片网格；**骨架屏那一版带 aria-busy="true"**
 *   .plugin-card <article>         已安装视图的卡片（host 的 InstalledPluginCard）
 *   .plugin-card.marketplace-card  在线插件视图的卡片（多这个类名，是区分两视图的唯一可靠依据）
 *   .plugin-card-name   <h3>       插件显示名
 *   .marketplace-tags > span       目录标签（来自 echo-plugins.json 的 tags，
 *                                  宿主持久化在 app_kv 的 plugins:catalog-tags:<id>）
 *   .plugin-feature-tags > span    能力标签（由 manifest.capabilities 生成）
 *   .plugin-card-id                「ID: <pluginId>」
 *   .plugin-status-badge           状态徽章：
 *                                    已安装卡 → 运行中/加载中/未运行/已停用/安全模式/出错/异常/无效/版本要求
 *                                    在线卡   → 已安装/未安装/可更新/版本要求
 *   .marketplace-install-btn       在线卡的安装按钮（文案 安装/已安装/更新，兜底判据）
 *
 * 状态判定（全部来自上面两处，不猜、不依赖自建数据）：
 *   已安装视图卡片：install = 'installed'（一定是装了的）；enabled = 卡片是否带 is-disabled
 *                   —— 宿主定义 is-disabled = !enabled || invalid || !compatible，即「没在跑」
 *   在线插件卡片：  install 读 .plugin-status-badge 文案（已安装/未安装/可更新）；
 *                   enabled = null（在线卡不暴露启用状态）
 *   ⚠️ 两个视图的 is-disabled 含义不同（在线卡上它表示「与主程序不兼容」），
 *      所以绝不能跨视图套用同一个判定。
 *
 * 四个必须记住的坑：
 *   1) 骨架屏卡片同样带 .plugin-card / .marketplace-tags，只能靠**网格的
 *      aria-busy="true"** 区分；否则加载期间会把占位标签当成真标签聚合出来。
 *   2) 隐藏卡片用**行内 style.display**，不要用 class：宿主卡片的 class 是
 *      `class:r([...])` 动态绑定，一旦卡片状态变化（启用/停用/可更新）Vue 会
 *      整串重写 el.className，把手加的 class 抹掉。行内 style 宿主从不触碰。
 *   3) 渲染函数里读的必须是响应式数据（view.* / settings.*）。插件的选中集合与
 *      匹配模式是普通变量，界面上要一律经 view.* 读，否则点了没反应。
 *   4) 分组只在「该维度真的有两种以上取值」时才显示 —— 否则会冒出
 *      「安装状态：已安装 7」这种筛不出任何东西的纯噪音组。
 *
 * 为什么不直接用 ctx.dom.observe：
 *   它的语义是「每个新出现的匹配元素只回调一次」（按元素去重），宿主机内原地
 *   重渲染卡片时不会再触发，用来做「实时过滤」会漏更新。所以这里自己起一个
 *   MutationObserver（只监听 childList / aria-busy）+ 一个 1s 兜底轮询，
 *   并且**每次同步只写有变化的节点**，不会产生 DOM 抖动。
 */

const STORAGE_KEY = 'tag-filter-store'

/** 「未标注」伪标签：给没有任何标签的卡片一个可筛选的身份，用户不会漏掉它们 */
const UNTAGGED_KEY = '\u0000untagged'
const UNTAGGED_LABEL = '未标注'

const MATCH_MODES = {
  any: { id: 'any', label: '任一', title: '选中多个标签时，只要插件带其中任意一个标签就会显示' },
  all: { id: 'all', label: '全部', title: '选中多个标签时，插件必须同时带有全部标签才会显示' }
}

/** 内置状态维度：不是标签，但和标签一样是一排可点选的 chip */
const FACET_DEFS = [
  {
    id: 'install',
    title: '安装状态',
    values: [
      { id: 'installed', label: '已安装', title: '插件已在本地安装' },
      { id: 'missing', label: '未安装', title: '插件还没有安装' },
      { id: 'update', label: '可更新', title: '已安装，且插件源里有更新的版本' }
    ]
  },
  {
    id: 'enabled',
    title: '启用状态',
    values: [
      { id: 'on', label: '已启用', title: '插件处于启用状态（含出错/安全模式）' },
      { id: 'off', label: '未启用', title: '插件已停用、无效或与主程序不兼容（即宿主标了 is-disabled）' }
    ]
  }
]

/** 分组展示顺序（也是分组标题） */
const GROUP_ORDER = ['shortcuts', 'install', 'enabled', 'tags', 'capability']
const GROUP_TITLES = {
  shortcuts: '快捷组',
  install: '安装状态',
  enabled: '启用状态',
  tags: '目录标签',
  capability: '能力标签'
}
const GROUP_ORDER_INDEX = GROUP_ORDER.reduce((map, id, index) => {
  map[id] = index
  return map
}, {})

const DEFAULT_SETTINGS = {
  /** 在插件管理面板注入筛选条 */
  enableFilterBar: true,
  /** 侧边栏「插件」分组里的「标签筛选」入口 */
  showSidebarEntry: true,
  /** 把选中条件与匹配模式写进插件存储，重启后恢复 */
  persistSelection: true,
  /** 默认匹配方式 */
  defaultMode: 'any',
  /** 在标签上显示该标签在当前视图里的插件数量 */
  showCounts: true,
  /** 显示「安装状态 / 启用状态」两组维度 */
  showFacets: true,
  /** 同时纳入「能力标签」（由 manifest.capabilities 生成） */
  includeFeatureTags: false,
  debug: false
}

/** 宿主 DOM 选择器 */
const DOM = {
  content: '.plugin-content',
  grid: '.plugin-card-grid',
  card: '.plugin-card',
  cardName: '.plugin-card-name',
  cardId: '.plugin-card-id',
  tags: '.marketplace-tags',
  featureTags: '.plugin-feature-tags',
  statusBadge: '.plugin-status-badge',
  installBtn: '.marketplace-install-btn'
}
const BUSY_ATTR = 'aria-busy'
/** 在线插件卡片的专属类名 */
const MARKETPLACE_CARD_CLASS = 'marketplace-card'
/** 已安装卡片上表示「没在跑」的类名 */
const DISABLED_CLASS = 'is-disabled'

/** 兜底轮询间隔：MutationObserver 覆盖不到的「原地重渲染」靠它收敛 */
const POLL_MS = 1000
/** DOM 变更后的合并窗口，避免一次重渲染触发几十次同步 */
const SYNC_DEBOUNCE_MS = 60
/** 快照最多记住多少个插件（写进宿主 app_kv，别无限膨胀） */
const SNAPSHOT_MAX = 400
/** 单个插件最多记住多少个标签 */
const SNAPSHOT_TAGS_MAX = 16
/** 自定义组最多多少个 / 每组最多几个标签 */
const GROUP_MAX = 24
const GROUP_TAGS_MAX = 60

/* ====================================================================== *
 * 纯函数区：不依赖 activate 闭包，可被无头测试与变异测试直接调用
 * ====================================================================== */

/** 压空白、去首尾、限长；标签来自第三方索引，不能信它有多干净 */
function normalizeText(value, max) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return text.length > max ? text.slice(0, max) : text
}

function normalizeTag(value) {
  return normalizeText(value, 40)
}

/** 标签身份键：大小写不敏感（上游索引里 `Lyrics` 与 `lyrics` 都出现过） */
function tagKeyOf(value) {
  return normalizeTag(value).toLowerCase()
}

/** 宿主渲染成 `ID: tag-filter`（兼容全角冒号与多余空格），去掉前缀才是真 id */
function stripIdPrefix(value) {
  return normalizeText(value, 120).replace(/^ID\s*[:：]\s*/i, '')
}

function isBusyGrid(grid) {
  if (!grid || typeof grid.getAttribute !== 'function') return false
  return String(grid.getAttribute(BUSY_ATTR) || '').toLowerCase() === 'true'
}

/** 元素的可见文本（标签是 <span> 纯文本，直接 textContent） */
function textOf(el) {
  if (!el) return ''
  const raw = typeof el.textContent === 'string' ? el.textContent : ''
  return raw.replace(/\s+/g, ' ').trim()
}

/** 元素是否带某个 class（只能读 className 字符串：宿主卡片是普通 <article>） */
function hasClass(el, name) {
  if (!el || !name) return false
  const raw = typeof el.className === 'string' ? el.className : ''
  if (!raw) return false
  return raw.split(/\s+/).indexOf(name) >= 0
}

/** 判断一组标签是否命中当前选择 */
function matchesSelection(tagKeys, selectedKeys, mode) {
  const tags = tagKeys instanceof Set ? tagKeys : new Set(Array.isArray(tagKeys) ? tagKeys : [])
  const keys = Array.isArray(selectedKeys) ? selectedKeys : Array.from(selectedKeys || [])
  if (keys.length === 0) return true
  if (mode === 'all') {
    for (const key of keys) if (!tags.has(key)) return false
    return true
  }
  for (const key of keys) if (tags.has(key)) return true
  return false
}

/* ---------- 状态维度 ---------- */

/** 空选择：三个维度各一个数组 */
function emptySelection() {
  return { tags: [], install: [], enabled: [] }
}

/** 把任意来源的选择对象规整成标准形状（含旧版本「只有标签数组」的兼容） */
function normalizeSelection(raw) {
  const out = emptySelection()
  if (Array.isArray(raw)) {
    out.tags = raw.map((key) => normalizeText(key, 60)).filter(Boolean)
  } else if (raw && typeof raw === 'object') {
    out.tags = (Array.isArray(raw.tags) ? raw.tags : []).map((key) => normalizeText(key, 60)).filter(Boolean)
    out.install = (Array.isArray(raw.install) ? raw.install : []).filter((v) => isFacetValue('install', v))
    out.enabled = (Array.isArray(raw.enabled) ? raw.enabled : []).filter((v) => isFacetValue('enabled', v))
  }
  out.tags = Array.from(new Set(out.tags))
  out.install = Array.from(new Set(out.install))
  out.enabled = Array.from(new Set(out.enabled))
  return out
}

function facetDef(id) {
  return FACET_DEFS.find((def) => def.id === id) || null
}

function isFacetValue(facetId, value) {
  const def = facetDef(facetId)
  return !!def && def.values.some((item) => item.id === value)
}

/** 取实体的某个维度值（缺失一律当 null，表示「该卡片不暴露这个维度」） */
function pickFacet(entity, facetId) {
  if (!entity || !entity.facets) return null
  const value = entity.facets[facetId]
  return value === undefined ? null : value
}

/**
 * 单维度匹配：该维度没选 → 放行；选了 → 值必须落在选中集合里。
 * null（卡片不暴露这个维度）在「选了该维度」时判为不匹配 —— 宁可筛掉，
 * 也不要让用户以为「未安装」里混进了状态不明的卡片。
 */
function matchesFacetValue(value, selected) {
  if (!Array.isArray(selected) || selected.length === 0) return true
  if (value === null || value === undefined) return false
  return selected.indexOf(value) >= 0
}

/** 完整判定：标签维度 且 各状态维度（维度之间 AND，维度内部 OR） */
function matchesEntity(entity, selection, mode) {
  if (!entity) return false
  const picked = selection && typeof selection === 'object' ? selection : emptySelection()
  if (!matchesSelection(entity.tagKeys, picked.tags || [], mode)) return false
  if (!matchesFacetValue(pickFacet(entity, 'install'), picked.install || [])) return false
  if (!matchesFacetValue(pickFacet(entity, 'enabled'), picked.enabled || [])) return false
  return true
}

function selectionCount(selection) {
  if (!selection || typeof selection !== 'object') return 0
  return (
    (selection.tags ? selection.tags.length : 0) +
    (selection.install ? selection.install.length : 0) +
    (selection.enabled ? selection.enabled.length : 0)
  )
}

/** 读取在线插件卡的安装状态（状态徽章优先，按钮文案兜底） */
const INSTALL_BADGE_TEXT = { 已安装: 'installed', 未安装: 'missing', 可更新: 'update' }

function readInstallState(card) {
  if (!card || typeof card.querySelector !== 'function') return null
  const badge = textOf(card.querySelector(DOM.statusBadge))
  if (INSTALL_BADGE_TEXT[badge]) return INSTALL_BADGE_TEXT[badge]
  const button = textOf(card.querySelector(DOM.installBtn))
  if (/已装|更新/.test(button)) return 'installed'
  if (/安装/.test(button)) return 'missing'
  return null
}

/** 读取一张卡片暴露出来的状态维度 */
function readCardFacets(card) {
  if (!card || typeof card.getAttribute !== 'function') return { install: null, enabled: null }
  if (hasClass(card, MARKETPLACE_CARD_CLASS)) {
    // 在线卡只暴露安装状态；启用状态它压根不渲染
    return { install: readInstallState(card), enabled: null }
  }
  // 已安装卡：一定是装了的；is-disabled = 宿主认为「没在跑」
  // 注意：维度值统一用 FACET_DEFS 里的字符串 id（'on' / 'off'），不要用布尔值 ——
  // 两套表示混用会让 buildFacetChips 认不出值，整组直接消失。
  return { install: 'installed', enabled: hasClass(card, DISABLED_CLASS) ? 'off' : 'on' }
}

/** 实体身份：优先插件 id，退化为显示名 */
function pickEntityKey(id, name) {
  if (id) return `id:${id}`
  if (name) return `name:${name}`
  return ''
}

/**
 * 从一张卡片读取标签。
 *
 * 只读 `.marketplace-tags` 里的 <span>（目录标签）；`includeFeatureTags` 打开时
 * 追加 `.plugin-feature-tags`（能力标签，如「网络」「本地文件」），并用 capability
 * 标记出来，界面上会单独归到「能力标签」一组，避免两种标签体系被混为一谈。
 */
function readCardTags(card, includeFeatureTags) {
  const out = []
  const seen = new Set()
  const collect = (container, capability) => {
    if (!container || typeof container.querySelectorAll !== 'function') return
    for (const span of Array.from(container.querySelectorAll('span'))) {
      const label = normalizeTag(textOf(span))
      if (!label) continue
      const key = tagKeyOf(label)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({ key, label, capability: !!capability })
    }
  }
  if (card && typeof card.querySelector === 'function') {
    collect(card.querySelector(DOM.tags), false)
    if (includeFeatureTags) collect(card.querySelector(DOM.featureTags), true)
  }
  return out
}

/** 按 key 去重：同一插件重复出现同名标签（大小写不同也算）会算成两个，必须先去重再统计 */
function dedupeTags(tags) {
  const out = []
  const seen = new Set()
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (!tag || !tag.key || seen.has(tag.key)) continue
    seen.add(tag.key)
    out.push(tag)
  }
  return out
}

/**
 * 卡片记录 → 插件实体。
 * 同一插件可能在页面上出现两次（宿主允许插件管理页被挂载多处），
 * 所以按身份合并、把元素收进 elements 数组，过滤时一起处理。
 */
function mergeRecords(records) {
  const map = new Map()
  for (const record of records) {
    const key = pickEntityKey(record.id, record.name)
    if (!key) continue
    let entity = map.get(key)
    if (!entity) {
      entity = {
        key,
        id: record.id,
        name: record.name,
        tags: [],
        tagKeys: new Set(),
        elements: [],
        facets: { install: null, enabled: null }
      }
      map.set(key, entity)
    }
    if (record.el) entity.elements.push(record.el)
    // 两次挂载给出的标签应当一致；取第一个非空的，避免空的把非空的覆盖掉
    if (entity.tags.length === 0 && record.tags && record.tags.length) {
      const tags = dedupeTags(record.tags)
      entity.tags = tags
      entity.tagKeys = new Set(tags.map((tag) => tag.key))
    }
    if (record.facets) {
      for (const id of ['install', 'enabled']) {
        if (entity.facets[id] === null && record.facets[id] !== undefined && record.facets[id] !== null) {
          entity.facets[id] = record.facets[id]
        }
      }
    }
  }
  for (const entity of map.values()) {
    if (entity.tags.length === 0) {
      entity.tags = [{ key: UNTAGGED_KEY, label: UNTAGGED_LABEL, untagged: true }]
      entity.tagKeys = new Set([UNTAGGED_KEY])
    }
  }
  return Array.from(map.values())
}

/** 从持久化的快照重建实体（没有 DOM 元素，只用于标签总览与统计） */
function entitiesFromSnapshot(items) {
  const records = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue
    const tags = dedupeTags(
      (Array.isArray(item.tags) ? item.tags : [])
        .map((tag) => normalizeTag(tag))
        .filter(Boolean)
        .slice(0, SNAPSHOT_TAGS_MAX)
        .map((label) => ({ key: tagKeyOf(label), label, capability: false }))
    )
    records.push({
      el: null,
      id: normalizeText(item.id, 120),
      name: normalizeText(item.name, 120),
      tags,
      facets: {
        install: isFacetValue('install', item.install) ? item.install : null,
        // 兼容早期版本存成布尔值的快照
        enabled: isFacetValue('enabled', item.enabled)
          ? item.enabled
          : typeof item.enabled === 'boolean'
            ? item.enabled
              ? 'on'
              : 'off'
            : null
      }
    })
  }
  return mergeRecords(records)
}

/** 自定义组规整：丢垃圾数据、限数量、去重 */
function normalizeGroups(raw) {
  const out = []
  const seenIds = new Set()
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue
    const id = normalizeText(item.id, 40)
    const name = normalizeText(item.name, 30)
    if (!id || !name || seenIds.has(id)) continue
    const tags = []
    for (const tag of Array.isArray(item.tags) ? item.tags : []) {
      const key = normalizeText(tag, 60)
      if (!key || tags.indexOf(key) >= 0) continue
      tags.push(key)
      if (tags.length >= GROUP_TAGS_MAX) break
    }
    if (!tags.length) continue
    seenIds.add(id)
    out.push({ id, name, tags })
    if (out.length >= GROUP_MAX) break
  }
  return out
}

/** 组在当前选择下的状态：全选 / 部分 / 未选 */
function groupSelectionState(group, selectedTags) {
  const set = selectedTags instanceof Set ? selectedTags : new Set(selectedTags || [])
  let hit = 0
  for (const key of group.tags) if (set.has(key)) hit += 1
  if (hit === 0) return 'none'
  return hit === group.tags.length ? 'all' : 'some'
}

/** 点击组：已经全选 → 全部取消；否则 → 全部选中（与现有选择取并集） */
function toggleGroupTags(group, selectedTags) {
  const set = new Set(selectedTags || [])
  const state = groupSelectionState(group, set)
  if (state === 'all') {
    for (const key of group.tags) set.delete(key)
  } else {
    for (const key of group.tags) set.add(key)
  }
  return Array.from(set)
}

/** 选择状态 → 统计（标签维度版本，保持老签名给测试用） */
function matchStats(entities, selectedKeys, mode) {
  return matchStatsFor(entities, { tags: selectedKeys || [], install: [], enabled: [] }, mode)
}

/** 选择状态 → 统计（完整版：三个维度都算） */
function matchStatsFor(entities, selection, mode) {
  const total = entities.length
  if (selectionCount(selection) === 0) return { total, matched: total, hidden: 0 }
  let matched = 0
  for (const entity of entities) {
    if (matchesEntity(entity, selection, mode)) matched += 1
  }
  return { total, matched, hidden: total - matched }
}

/**
 * 生成标签 chip 列表（只处理标签维度）。
 *
 * - `count`：当前视图里带这个标签的插件数（稳定值，不随选择变化）→ 展示与排序用它；
 * - `alive`：**把该标签加入当前选择后**还会匹配多少插件 → 「选中后共 N 个匹配」提示用它；
 *   带 `baseFilter` 时它是「其它维度条件也满足」的结果数；
 * - `dead`：加入后一个都不匹配（只可能出现在未选中的 chip 上）→ 视觉上弱化。
 *
 * 排序刻意只用 count + 标签名，不掺 alive：否则点一下标签整排顺序就变，
 * 光标下的 chip 会跳走。
 */
function buildChips(entities, selectedKeys, mode, labels, baseFilter) {
  const selectedSet = new Set(selectedKeys || [])
  const presence = new Map()
  for (const entity of entities) {
    for (const tag of entity.tags) {
      const current = presence.get(tag.key)
      if (current) current.count += 1
      else {
        presence.set(tag.key, {
          key: tag.key,
          label: tag.label,
          capability: !!tag.capability,
          untagged: !!tag.untagged,
          count: 1
        })
      }
    }
  }
  // 已选但在当前视图里不存在的标签也要列出来，否则用户没法取消它（切视图时会遇到）
  for (const key of selectedKeys || []) {
    if (presence.has(key)) continue
    presence.set(key, {
      key,
      label: (labels && labels.get(key)) || (key === UNTAGGED_KEY ? UNTAGGED_LABEL : key),
      capability: false,
      untagged: key === UNTAGGED_KEY,
      count: 0
    })
  }

  const chips = []
  for (const entry of presence.values()) {
    const withKey = selectedSet.has(entry.key) ? selectedKeys : (selectedKeys || []).concat(entry.key)
    let alive = 0
    for (const entity of entities) {
      if (baseFilter && !baseFilter(entity)) continue
      if (matchesSelection(entity.tagKeys, withKey, mode)) alive += 1
    }
    chips.push({
      key: entry.key,
      kind: entry.untagged ? 'untagged' : entry.capability ? 'capability' : 'tag',
      label: entry.label,
      capability: entry.capability,
      untagged: entry.untagged,
      count: entry.count,
      alive,
      selected: selectedSet.has(entry.key),
      dead: alive === 0 && !selectedSet.has(entry.key)
    })
  }
  chips.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
  return chips
}

/** 生成一个状态维度的 chip（值集合 = 视图里出现过的值 ∪ 已选值） */
function buildFacetChips(facetId, entities, selection, mode) {
  const def = facetDef(facetId)
  if (!def) return []
  const selected = selection[facetId] || []
  const present = new Set()
  for (const entity of entities) {
    const value = pickFacet(entity, facetId)
    if (value !== null) present.add(value)
  }
  const chips = []
  for (const item of def.values) {
    const isPresent = present.has(item.id)
    const isSelected = selected.indexOf(item.id) >= 0
    if (!isPresent && !isSelected) continue
    const nextSelection = isSelected
      ? selection
      : { ...selection, [facetId]: selected.concat(item.id) }
    let alive = 0
    for (const entity of entities) {
      if (matchesEntity(entity, nextSelection, mode)) alive += 1
    }
    let count = 0
    for (const entity of entities) if (pickFacet(entity, facetId) === item.id) count += 1
    chips.push({
      key: `${facetId}:${item.id}`,
      kind: 'facet',
      facet: facetId,
      value: item.id,
      label: item.label,
      hint: item.title || '',
      count,
      alive,
      selected: isSelected,
      dead: alive === 0 && !isSelected
    })
  }
  return chips
}

/** 生成一个自定义组的 chip（点一下 = 一次选中/取消组内全部标签） */
function buildGroupChips(groups, entities, selection) {
  const selectedSet = new Set(selection.tags || [])
  return (groups || []).map((group) => {
    const state = groupSelectionState(group, selectedSet)
    let present = 0
    for (const key of group.tags) {
      for (const entity of entities) {
        if (entity.tagKeys.has(key)) {
          present += 1
          break
        }
      }
    }
    let selectedCount = 0
    for (const key of group.tags) if (selectedSet.has(key)) selectedCount += 1
    return {
      key: `group:${group.id}`,
      kind: 'group',
      groupId: group.id,
      label: group.name,
      count: group.tags.length,
      present,
      selectedCount,
      selected: state === 'all',
      partial: state === 'some'
    }
  })
}

/**
 * 组装分组。
 *
 * 一条硬规则：**只在某个维度真的有两种以上取值时才显示这一组**。
 * 否则「已安装视图」里会冒出「安装状态：已安装 7」这种筛不出任何东西的纯噪音组。
 */
function buildGroups(entities, selection, mode, labels, options) {
  const opts = options || {}
  const baseFilter = (entity) => matchesEntity(entity, selection, mode)
  const groups = []

  const groupChips = buildGroupChips(opts.customGroups, entities, selection)
  if (groupChips.length) {
    groups.push({ id: 'shortcuts', kind: 'group', title: GROUP_TITLES.shortcuts, chips: groupChips })
  }

  if (opts.showFacets !== false) {
    for (const def of FACET_DEFS) {
      const chips = buildFacetChips(def.id, entities, selection, mode)
      if (chips.length < 2) continue
      groups.push({ id: def.id, kind: 'facet', title: def.title, chips })
    }
  }

  const allTagChips = buildChips(entities, selection.tags || [], mode, labels, baseFilter)
  const catalogChips = allTagChips.filter((chip) => !chip.capability)
  const capabilityChips = allTagChips.filter((chip) => chip.capability)
  if (catalogChips.length) {
    groups.push({ id: 'tags', kind: 'tag', title: GROUP_TITLES.tags, chips: catalogChips })
  }
  if (capabilityChips.length) {
    groups.push({ id: 'capability', kind: 'tag', title: GROUP_TITLES.capability, chips: capabilityChips })
  }

  groups.sort((a, b) => (GROUP_ORDER_INDEX[a.id] ?? 99) - (GROUP_ORDER_INDEX[b.id] ?? 99))
  return groups
}

/** chip 列表是否等价（避免每秒重建导致的无意义重渲染） */
function sameChips(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (!x || !y) return false
    if (
      x.key !== y.key ||
      x.label !== y.label ||
      x.count !== y.count ||
      x.alive !== y.alive ||
      x.selected !== y.selected ||
      x.dead !== y.dead ||
      !!x.partial !== !!y.partial ||
      x.present !== y.present ||
      x.selectedCount !== y.selectedCount
    ) {
      return false
    }
  }
  return true
}

/** 分组列表是否等价 */
function sameGroups(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (!x || !y) return false
    if (x.id !== y.id || x.title !== y.title || x.kind !== y.kind) return false
    if (!sameChips(x.chips, y.chips)) return false
  }
  return true
}

/* ====================================================================== *
 * 插件入口
 * ====================================================================== */

export async function activate(ctx) {
  const { h, reactive, defineComponent } = ctx.vue

  /* ---------- 基础 ---------- */

  const log = (...args) => {
    if (settings.debug) console.log('[tag-filter]', ...args)
  }

  const toast = (level, message) => {
    try {
      if (ctx.toast && typeof ctx.toast[level] === 'function') ctx.toast[level](message)
    } catch (error) {
      log('提示失败', error)
    }
  }

  /* ---------- 状态 ---------- *
   * settings / view / catalog 必须是 reactive：界面直接读它们渲染。
   * 选中集合、匹配模式、自定义组是普通变量，界面上一律经 view.* 读。
   */

  const settings = reactive({ ...DEFAULT_SETTINGS })
  let selection = emptySelection()
  let mode = DEFAULT_SETTINGS.defaultMode
  let customGroups = []

  /** 最近一次 DOM 扫描到的实体（含元素引用，**不能**塞进 reactive） */
  let liveEntities = []
  /** 快照实体是**派生**的：按 snapshot.items 的对象身份缓存，避免每秒重建，也不可能与快照脱节 */
  let snapshotCacheKey = null
  let snapshotCacheValue = []
  let snapshot = { at: 0, source: '', items: [], fingerprint: '' }
  /** key → 展示名，用于当前视图里不存在的已选标签 */
  const labels = new Map()
  /** 自定义组 id 自增用 */
  let groupSeq = 0

  /** 被我们改过 display 的元素，停用时逐个还原 */
  const touched = new Set()

  const hosts = new Map()
  let observer = null
  let pollTimer = null
  let syncTimer = null
  let saveTimer = null
  let disposed = false
  /** 上一次落进 reactive 的数据指纹，用来避免无意义重渲染 */
  let lastSig = ''

  const view = reactive({
    visible: false,
    groups: [],
    selected: [],
    /** 已选条件的扁平 chip 列表（收起时展示、空状态里列举） */
    selectedChips: [],
    conditionCount: 0,
    mode: DEFAULT_SETTINGS.defaultMode,
    total: 0,
    matched: 0,
    hidden: 0,
    tagCount: 0,
    untaggedCount: 0,
    noMatch: false,
    source: 'live',
    barFocused: false,
    /** 标签区分组整体是否展开 */
    expanded: true,
    /** 每个分组的折叠状态 { [groupId]: true } */
    groupCollapsed: {},
    groupCount: 0
  })

  /** 独立页面用的目录（实时扫描优先，否则用快照） */
  const catalog = reactive({
    at: 0,
    source: '',
    total: 0,
    chipCount: 0,
    groups: [],
    fromSnapshot: true
  })

  /**
   * 快照 → 实体。
   * 刻意做成「派生」而不是另存一份：只要 snapshot.items 还是同一个数组就复用，
   * 换了就重建。这样「面板里实时读到的标签」与「面板关掉后页面上看到的标签」
   * 永远来自同一处，也不会出现两边不同步。
   */
  function snapshotEntities() {
    if (snapshotCacheKey !== snapshot.items) {
      snapshotCacheKey = snapshot.items
      snapshotCacheValue = snapshot.items.length ? entitiesFromSnapshot(snapshot.items) : []
    }
    return snapshotCacheValue
  }

  const currentEntities = () => (liveEntities.length ? liveEntities : snapshotEntities())

  /* ---------- 持久化 ---------- */

  function buildSnapshotItems(entities) {
    const items = []
    for (const entity of entities.slice(0, SNAPSHOT_MAX)) {
      const untaggedOnly = entity.tags.length === 1 && entity.tags[0].untagged
      const item = {
        id: entity.id || '',
        name: entity.name || '',
        tags: untaggedOnly ? [] : entity.tags.map((tag) => tag.label).slice(0, SNAPSHOT_TAGS_MAX)
      }
      const install = pickFacet(entity, 'install')
      const enabled = pickFacet(entity, 'enabled')
      if (install !== null) item.install = install
      if (enabled !== null) item.enabled = enabled
      items.push(item)
    }
    return items
  }

  function scheduleSave() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persist()
    }, 400)
  }

  async function persist() {
    if (!ctx.storage || typeof ctx.storage.set !== 'function') return
    const keep = !!settings.persistSelection
    const payload = {
      settings: { ...settings },
      selection: keep ? normalizeSelection(selection) : emptySelection(),
      mode: keep ? mode : settings.defaultMode,
      groups: customGroups.map((group) => ({ id: group.id, name: group.name, tags: group.tags.slice() })),
      ui: {
        expanded: view.expanded,
        groupCollapsed: { ...view.groupCollapsed }
      },
      snapshot: {
        at: snapshot.at,
        source: snapshot.source,
        items: snapshot.items
      }
    }
    try {
      await ctx.storage.set(STORAGE_KEY, payload)
    } catch (error) {
      log('保存失败', error)
    }
  }

  function applyLoaded(saved) {
    Object.assign(settings, DEFAULT_SETTINGS)
    if (saved && saved.settings && typeof saved.settings === 'object') {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (saved.settings[key] !== undefined) settings[key] = saved.settings[key]
      }
    }
    if (!MATCH_MODES[settings.defaultMode]) settings.defaultMode = DEFAULT_SETTINGS.defaultMode
    mode = settings.defaultMode

    if (saved && settings.persistSelection) {
      selection = normalizeSelection(saved.selection)
      if (MATCH_MODES[saved.mode]) mode = saved.mode
    } else {
      selection = emptySelection()
    }

    customGroups = normalizeGroups(saved && saved.groups)

    if (saved && saved.ui && typeof saved.ui === 'object') {
      view.expanded = saved.ui.expanded === undefined ? true : !!saved.ui.expanded
      const collapsed = {}
      if (saved.ui.groupCollapsed && typeof saved.ui.groupCollapsed === 'object') {
        for (const key of Object.keys(saved.ui.groupCollapsed)) {
          if (saved.ui.groupCollapsed[key]) collapsed[normalizeText(key, 40)] = true
        }
      }
      view.groupCollapsed = collapsed
    }

    const raw = saved && saved.snapshot && typeof saved.snapshot === 'object' ? saved.snapshot : null
    if (raw) {
      snapshot = {
        at: Number(raw.at) || 0,
        source: normalizeText(raw.source, 20),
        items: Array.isArray(raw.items) ? raw.items : [],
        fingerprint: ''
      }
    }
  }

  /* ---------- DOM 扫描 ---------- */

  function cardQuery(card, selector) {
    if (!card || typeof card.querySelector !== 'function') return null
    return card.querySelector(selector)
  }

  function scanLive() {
    if (typeof document === 'undefined') return []
    const records = []
    for (const grid of Array.from(document.querySelectorAll(DOM.grid))) {
      // 骨架屏网格：里面的 .plugin-card 是占位卡片，标签与状态徽章也是假的
      if (isBusyGrid(grid)) continue
      if (typeof grid.querySelectorAll !== 'function') continue
      for (const card of Array.from(grid.querySelectorAll(DOM.card))) {
        const id = stripIdPrefix(textOf(cardQuery(card, DOM.cardId)))
        const name = normalizeText(textOf(cardQuery(card, DOM.cardName)), 120)
        if (!id && !name) continue
        records.push({
          el: card,
          id,
          name,
          tags: readCardTags(card, settings.includeFeatureTags),
          facets: readCardFacets(card)
        })
      }
    }
    return mergeRecords(records)
  }

  function rememberLabels(entities) {
    for (const entity of entities) {
      for (const tag of entity.tags) {
        if (tag.untagged) continue
        if (!labels.has(tag.key)) labels.set(tag.key, tag.label)
      }
    }
  }

  /* ---------- 过滤 ---------- */

  function applyFilter() {
    for (const entity of liveEntities) {
      const hide = !matchesEntity(entity, selection, mode)
      for (const el of entity.elements || []) {
        if (!el || !el.style) continue
        const want = hide ? 'none' : ''
        if (el.style.display !== want) el.style.display = want
        if (hide) touched.add(el)
        else touched.delete(el)
      }
    }
  }

  function restoreAll() {
    for (const el of touched) {
      try {
        if (el && el.style) el.style.display = ''
      } catch (error) {
        /* 元素可能已被移除，忽略 */
      }
    }
    touched.clear()
  }

  /** 当前停留在哪个视图（只用于文案与诊断） */
  function describeView() {
    if (typeof document === 'undefined') return ''
    try {
      if (document.querySelector('.marketplace-toolbar')) return 'marketplace'
    } catch (error) {
      /* 忽略 */
    }
    return 'installed'
  }

  /**
   * 重算分组 / 统计 / 过滤效果。
   * 所有要显示的数据都在这里落进 reactive，并且**只在真的变了的时候写**，
   * 这样 1s 的兜底轮询不会造成每秒一次重渲染。
   */
  function recompute() {
    const entities = currentEntities()
    const stats = matchStatsFor(entities, selection, mode)
    const groups = buildGroups(entities, selection, mode, labels, {
      customGroups,
      showFacets: settings.showFacets
    })
    const isLive = liveEntities.length > 0
    const selectedChips = []
    let chipTotal = 0
    for (const group of groups) {
      for (const chip of group.chips) {
        chipTotal += 1
        if (chip.selected && chip.kind !== 'group') selectedChips.push(chip)
      }
    }

    const sig = [
      groups
        .map((group) => `${group.id}[${group.chips.map((chip) => `${chip.key}:${chip.count}:${chip.alive}:${chip.selected ? 1 : 0}:${chip.partial ? 1 : 0}`).join('/')}]`)
        .join(','),
      stats.total,
      stats.matched,
      stats.hidden,
      isLive ? 1 : 0,
      mode,
      normalizeSelection(selection).tags.join('\u0001') +
        '#' +
        (selection.install || []).join('\u0001') +
        '#' +
        (selection.enabled || []).join('\u0001'),
      view.expanded ? 1 : 0,
      Object.keys(view.groupCollapsed).filter((key) => view.groupCollapsed[key]).join(',')
    ].join('\u0002')

    if (!sameGroups(view.groups, groups)) view.groups = groups

    if (sig !== lastSig) {
      lastSig = sig
      view.selected = normalizeSelection(selection).tags.slice()
      view.selectedChips = selectedChips
      view.conditionCount = selectionCount(selection)
      view.mode = mode
      view.total = stats.total
      view.matched = stats.matched
      view.hidden = stats.hidden
      view.tagCount = groups
        .filter((group) => group.kind === 'tag')
        .reduce((n, group) => n + group.chips.filter((chip) => chip.kind === 'tag').length, 0)
      view.untaggedCount = groups.reduce(
        (n, group) => n + group.chips.reduce((m, chip) => m + (chip.kind === 'untagged' ? chip.count : 0), 0),
        0
      )
      view.groupCount = groups.length
      view.noMatch = selectionCount(selection) > 0 && stats.matched === 0
      view.source = isLive ? 'live' : 'snapshot'
      view.visible = stats.total > 0 && groups.length > 0
    }

    if (!sameGroups(catalog.groups, groups)) catalog.groups = groups
    catalog.total = stats.total
    catalog.chipCount = chipTotal
    catalog.fromSnapshot = !isLive
    catalog.source = isLive ? describeView() : snapshot.source
    catalog.at = isLive ? Date.now() : snapshot.at

    applyFilter()
  }

  /* ---------- 注入 / 卸载筛选条 ---------- */

  function dropHost(container) {
    const entry = hosts.get(container)
    if (!entry) return
    hosts.delete(container)
    if (typeof entry.dispose === 'function') {
      try {
        entry.dispose()
      } catch (error) {
        log('卸载筛选条失败', error)
      }
    }
    try {
      if (entry.host && entry.host.parentNode) entry.host.parentNode.removeChild(entry.host)
    } catch (error) {
      log('移除筛选条容器失败', error)
    }
  }

  function dropAllHosts() {
    for (const container of Array.from(hosts.keys())) dropHost(container)
  }

  /**
   * 让「一个宿主内容容器 = 一条筛选条」。
   *
   * 位置选在**卡片网格正上方**：两种视图的网格都在标题行之下，
   * 这样「已安装」与「在线插件」的观感完全一致；容器里没有可用网格
   * （空状态、骨架屏）时不注入，避免在没东西可筛的时候还占一行。
   */
  function syncHosts() {
    if (!settings.enableFilterBar || typeof document === 'undefined') {
      dropAllHosts()
      return
    }

    const keep = new Set()
    for (const grid of Array.from(document.querySelectorAll(DOM.grid))) {
      if (isBusyGrid(grid)) continue
      if (typeof grid.querySelector !== 'function' || !grid.querySelector(DOM.card)) continue
      const container = grid.parentNode
      if (!container || keep.has(container)) continue
      keep.add(container)

      let entry = hosts.get(container)
      if (entry && (!entry.host || !entry.host.isConnected)) {
        dropHost(container)
        entry = null
      }

      if (!entry) {
        let host = null
        try {
          host = document.createElement('div')
          host.className = 'etf-host'
          host.setAttribute('data-etf-host', '1')
          container.insertBefore(host, grid)
          let dispose = null
          try {
            dispose = ctx.ui.mount(host, TagFilterBar)
          } catch (error) {
            log('挂载筛选条失败', error)
          }
          hosts.set(container, { host, dispose: typeof dispose === 'function' ? dispose : null })
          log('已注入筛选条')
        } catch (error) {
          log('注入筛选条容器失败', error)
          try {
            if (host && host.parentNode) host.parentNode.removeChild(host)
          } catch (inner) {
            /* 忽略 */
          }
        }
      } else if (entry.host.nextSibling !== grid) {
        // 网格被宿主换成了新元素，把筛选条挪回它上面
        try {
          container.insertBefore(entry.host, grid)
        } catch (error) {
          log('调整筛选条位置失败', error)
        }
      }
    }

    for (const container of Array.from(hosts.keys())) {
      if (!keep.has(container) || !container.isConnected) dropHost(container)
    }
  }

  /* ---------- 主循环 ---------- */

  function sync() {
    if (disposed) return

    if (!settings.enableFilterBar) {
      // 关掉筛选条时不能只是不注入：已经隐藏的卡片必须还原
      dropAllHosts()
      liveEntities = []
      restoreAll()
      recompute()
      return
    }

    liveEntities = scanLive()
    rememberLabels(liveEntities)
    syncHosts()

    // 实时数据有变化时刷新快照（供「标签筛选」独立页面做标签总览）
    if (liveEntities.length > 0) {
      const items = buildSnapshotItems(liveEntities)
      const fingerprint = items
        .map((item) => `${item.id}|${item.tags.join(',')}|${item.install || ''}|${item.enabled === undefined ? '' : item.enabled}`)
        .join(';')
      if (fingerprint !== snapshot.fingerprint) {
        // snapshot.items 换新数组即触发快照实体重建，不需要在这里手动同步
        snapshot = { at: Date.now(), source: describeView(), items, fingerprint }
        scheduleSave()
      }
    }
    recompute()
  }

  function scheduleSync() {
    if (disposed || syncTimer) return
    syncTimer = setTimeout(() => {
      syncTimer = null
      try {
        sync()
      } catch (error) {
        log('同步失败', error)
      }
    }, SYNC_DEBOUNCE_MS)
  }

  function startWatching() {
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.body) {
      observer = new MutationObserver(scheduleSync)
      try {
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [BUSY_ATTR]
        })
      } catch (error) {
        log('启动 DOM 监听失败', error)
      }
    }
    pollTimer = setInterval(() => {
      try {
        sync()
      } catch (error) {
        log('轮询同步失败', error)
      }
    }, POLL_MS)
  }

  /* ---------- 交互 ---------- */

  function toggleTag(key) {
    if (!key) return
    const tags = selection.tags || []
    selection = {
      ...selection,
      tags: tags.indexOf(key) >= 0 ? tags.filter((item) => item !== key) : tags.concat(key)
    }
    afterSelectionChange(`标签 ${key}`)
  }

  function toggleFacet(facetId, value) {
    if (!isFacetValue(facetId, value)) return
    const current = selection[facetId] || []
    selection = {
      ...selection,
      [facetId]: current.indexOf(value) >= 0 ? current.filter((item) => item !== value) : current.concat(value)
    }
    afterSelectionChange(`${facetId}=${value}`)
  }

  function toggleGroupMembers(groupId) {
    const group = customGroups.find((item) => item.id === groupId)
    if (!group) return
    selection = { ...selection, tags: toggleGroupTags(group, selection.tags || []) }
    afterSelectionChange(`组 ${group.name}`)
  }

  /** 点击 chip 的统一入口 */
  function activateChip(chip) {
    if (!chip) return
    if (chip.kind === 'group') toggleGroupMembers(chip.groupId)
    else if (chip.kind === 'facet') toggleFacet(chip.facet, chip.value)
    else toggleTag(chip.key)
  }

  function afterSelectionChange(reason) {
    recompute()
    scheduleSave()
    log('筛选变化', reason)
  }

  function clearSelection() {
    if (selectionCount(selection) === 0) return
    selection = emptySelection()
    recompute()
    scheduleSave()
    log('已清除筛选')
  }

  function setMode(next) {
    if (!MATCH_MODES[next] || next === mode) return
    mode = next
    recompute()
    scheduleSave()
  }

  function toggleExpanded() {
    view.expanded = !view.expanded
    recompute()
    scheduleSave()
  }

  function toggleGroupCollapsed(groupId) {
    if (!groupId) return
    const next = { ...view.groupCollapsed }
    if (next[groupId]) delete next[groupId]
    else next[groupId] = true
    view.groupCollapsed = next
    recompute()
    scheduleSave()
  }

  const isGroupCollapsed = (groupId) => !!view.groupCollapsed[groupId]

  /* ---------- 自定义组 ---------- */

  function newGroupId() {
    groupSeq += 1
    return `g${Date.now().toString(36)}${groupSeq.toString(36)}`
  }

  function createGroupFromSelection(name) {
    const tags = (selection.tags || []).slice()
    if (!tags.length) {
      toast('warning', '请先在筛选条里选中至少一个标签，再用它建组')
      return null
    }
    if (customGroups.length >= GROUP_MAX) {
      toast('warning', `最多 ${GROUP_MAX} 个自定义组`)
      return null
    }
    const label = normalizeText(name, 30) || `组 ${customGroups.length + 1}`
    const group = { id: newGroupId(), name: label, tags }
    customGroups = customGroups.concat(group)
    recompute()
    scheduleSave()
    toast('success', `已建组「${label}」，含 ${tags.length} 个标签`)
    return group
  }

  function replaceGroupMembers(groupId) {
    const group = customGroups.find((item) => item.id === groupId)
    if (!group) return
    if (!(selection.tags || []).length) {
      toast('warning', '请先选中标签，再覆盖这个组')
      return
    }
    group.tags = (selection.tags || []).slice()
    recompute()
    scheduleSave()
    toast('success', `已用当前筛选更新「${group.name}」`)
  }

  function removeGroupMember(groupId, tagKey) {
    const group = customGroups.find((item) => item.id === groupId)
    if (!group) return
    group.tags = group.tags.filter((key) => key !== tagKey)
    if (!group.tags.length) {
      customGroups = customGroups.filter((item) => item.id !== groupId)
      toast('info', `「${group.name}」已空了，顺手删掉了`)
    }
    recompute()
    scheduleSave()
  }

  function renameGroup(groupId, name) {
    const group = customGroups.find((item) => item.id === groupId)
    if (!group) return
    const label = normalizeText(name, 30)
    if (!label || label === group.name) return
    group.name = label
    recompute()
    scheduleSave()
  }

  function removeGroup(groupId) {
    const group = customGroups.find((item) => item.id === groupId)
    if (!group) return
    customGroups = customGroups.filter((item) => item.id !== groupId)
    const next = { ...view.groupCollapsed }
    delete next[groupId]
    view.groupCollapsed = next
    recompute()
    scheduleSave()
    toast('info', `已删除组「${group.name}」`)
  }

  function focusBar() {
    if (typeof document === 'undefined') return false
    const host = document.querySelector('.etf-host')
    if (!host) {
      toast('info', '请先打开「设置 → 插件」页面，筛选条在插件列表上方')
      return false
    }
    if (host.scrollIntoView) {
      try {
        host.scrollIntoView({ block: 'center', behavior: 'smooth' })
      } catch (error) {
        /* 老内核忽略参数即可 */
      }
    }
    view.barFocused = true
    setTimeout(() => {
      view.barFocused = false
    }, 1600)
    return true
  }

  /* ---------- 界面片段 ---------- */

  const icon = (path, size) =>
    h(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: size || 15,
        height: size || 15,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        style: 'flex-shrink:0'
      },
      [h('path', { d: path })]
    )

  const ICON_FILTER = 'M3 5h18 M6 12h12 M10 19h4'
  const ICON_CLEAR = 'M18 6 6 18 M6 6l12 12'
  const ICON_SEARCH = 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4'
  const ICON_LAYERS = 'M12 3 3 8l9 5 9-5-9-5z M3 16l9 5 9-5 M3 12l9 5 9-5'
  const ICON_CHEVRON_DOWN = 'M6 9l6 6 6-6'
  const ICON_CHEVRON_RIGHT = 'M9 6l6 6-6 6'
  const ICON_PLUS = 'M12 5v14 M5 12h14'
  const ICON_TRASH = 'M3 6h18 M8 6V4h8v2 M6 6l1 14h10l1-14'

  function chipKindLabels(chip) {
    if (chip.kind === 'capability') return '能力标签'
    if (chip.kind === 'untagged') return '没有任何标签的插件'
    if (chip.kind === 'facet') return facetDef(chip.facet) ? facetDef(chip.facet).title : '状态'
    if (chip.kind === 'group') return `快捷组「${chip.label}」`
    return '标签'
  }

  function chipTitle(chip) {
    const kind = chipKindLabels(chip)
    if (chip.kind === 'group') {
      const extra = chip.present === 0 ? '（本视图里暂时没有这些标签）' : ''
      return `${kind}：含 ${chip.count} 个标签，已选 ${chip.selectedCount} 个${extra}；点击一次${
        chip.selected ? '全部取消' : '全部选中'
      }`
    }
    const hint = chip.hint ? `（${chip.hint}）` : ''
    if (chip.dead) return `${kind}${hint}：在当前筛选条件下没有插件符合`
    if (chip.selected) return `${kind}${hint}：当前共 ${chip.alive} 个插件匹配；点击取消选择`
    return `${kind}${hint}：选中后共 ${chip.alive} 个插件匹配`
  }

  function chipBadgeText(chip) {
    if (chip.kind === 'group') return `${chip.selectedCount}/${chip.count}`
    if (!settings.showCounts) return ''
    return String(chip.count)
  }

  function renderChip(chip, extraClass) {
    const classes = ['etf-chip']
    if (extraClass) classes.push(extraClass)
    if (chip.selected) classes.push('is-on')
    if (chip.partial) classes.push('is-partial')
    if (chip.dead) classes.push('is-dead')
    if (chip.kind === 'capability') classes.push('is-cap')
    if (chip.kind === 'untagged') classes.push('is-untagged')
    if (chip.kind === 'facet') classes.push('is-facet')
    if (chip.kind === 'group') classes.push('is-group')

    const attrs = {
      key: chip.key,
      class: classes.join(' '),
      type: 'button',
      title: chipTitle(chip),
      'aria-pressed': chip.selected ? 'true' : 'false',
      'data-key': chip.key,
      'data-kind': chip.kind,
      'data-count': String(chip.count),
      'data-selected': chip.selected ? '1' : '0',
      onClick: () => activateChip(chip)
    }
    if (chip.kind === 'tag' || chip.kind === 'capability' || chip.kind === 'untagged') {
      attrs['data-tag'] = chip.untagged ? '__untagged__' : chip.key
      attrs['data-capability'] = chip.capability ? '1' : '0'
    }
    if (chip.kind === 'facet') {
      attrs['data-facet'] = chip.facet
      attrs['data-value'] = chip.value
    }
    if (chip.kind === 'group') {
      attrs['data-group'] = chip.groupId
      attrs['data-partial'] = chip.partial ? '1' : '0'
    }

    const badge = chipBadgeText(chip)
    return h('button', attrs, [
      h('span', { class: 'etf-chip-label' }, chip.label),
      badge ? h('span', { class: 'etf-chip-count' }, badge) : null
    ])
  }

  /** 收起时展示的「已选条件」行（点一下即取消该条件） */
  function renderSelectedSummary() {
    const chips = view.selectedChips
    if (!chips.length) {
      return h('div', { class: 'etf-bar-summary', 'data-role': 'summary' }, [
        h('span', { class: 'etf-summary-empty' }, '未选择筛选条件')
      ])
    }
    return h(
      'div',
      { class: 'etf-bar-summary', 'data-role': 'summary' },
      chips.map((chip) =>
        h(
          'button',
          {
            key: `sel:${chip.key}`,
            class: 'etf-chip etf-chip-mini is-on',
            type: 'button',
            title: `点击取消「${chip.label}」`,
            'data-key': chip.key,
            'data-summary': '1',
            onClick: () => activateChip(chip)
          },
          [h('span', { class: 'etf-chip-label' }, chip.label), h('span', { class: 'etf-chip-remove' }, '×')]
        )
      )
    )
  }

  function renderModeSwitch(extraClass) {
    const current = view.mode
    return h(
      'div',
      { class: `etf-seg${extraClass ? ' ' + extraClass : ''}`, role: 'group', 'aria-label': '匹配方式' },
      Object.values(MATCH_MODES).map((item) =>
        h(
          'button',
          {
            key: item.id,
            class: `etf-seg-btn${current === item.id ? ' is-on' : ''}`,
            type: 'button',
            title: item.title,
            'aria-pressed': current === item.id ? 'true' : 'false',
            'data-mode': item.id,
            onClick: () => setMode(item.id)
          },
          item.label
        )
      )
    )
  }

  function renderClearButton(extraClass, label) {
    return h(
      'button',
      {
        class: `etf-clear${extraClass ? ' ' + extraClass : ''}`,
        type: 'button',
        disabled: view.conditionCount === 0,
        'data-action': 'clear',
        onClick: () => clearSelection()
      },
      [icon(ICON_CLEAR, 12), h('span', {}, label || '清除筛选')]
    )
  }

  function renderExpandButton() {
    return h(
      'button',
      {
        class: `etf-toggle${view.expanded ? ' is-open' : ''}`,
        type: 'button',
        title: view.expanded ? '收起标签区' : '展开全部标签与状态条件',
        'data-action': 'toggle-expand',
        'data-expanded': view.expanded ? '1' : '0',
        'aria-expanded': view.expanded ? 'true' : 'false',
        onClick: () => toggleExpanded()
      },
      [
        icon(view.expanded ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT, 13),
        h('span', {}, view.expanded ? '收起' : `展开筛选（${view.groupCount} 组）`)
      ]
    )
  }

  function renderEmptyState() {
    const labelsText = view.selectedChips.map((chip) => chip.label)
    const detail = labelsText.length ? `已选条件：${labelsText.join('、')}` : '当前没有插件符合所选条件'
    return h('div', { class: 'etf-empty', 'data-role': 'empty' }, [
      h('span', { class: 'etf-empty-icon' }, [icon(ICON_SEARCH, 20)]),
      h('p', { class: 'etf-empty-title' }, '没有符合条件的插件'),
      h('p', { class: 'etf-empty-desc' }, `${detail}。试试少选几个条件，或清除筛选回到完整列表。`),
      h(
        'button',
        {
          class: 'etf-empty-btn',
          type: 'button',
          'data-action': 'clear',
          onClick: () => clearSelection()
        },
        '清除筛选'
      )
    ])
  }

  function renderStatus() {
    const pieces = []
    if (view.conditionCount === 0) {
      pieces.push(`共 ${view.total} 个插件`)
      pieces.push(`${view.tagCount} 个标签`)
      if (view.untaggedCount > 0) pieces.push(`${view.untaggedCount} 个未标注`)
      if (view.source === 'snapshot') pieces.push('上次采集')
    } else {
      pieces.push(`显示 ${view.matched} / ${view.total}`)
      pieces.push(`已选 ${view.conditionCount} 个条件`)
      if (view.hidden > 0) pieces.push(`隐藏 ${view.hidden} 个`)
    }
    return h('div', { class: 'etf-status', 'data-role': 'status' }, pieces.join(' · '))
  }

  /**
   * 降级提示：宿主没给出任何标签（例如所有插件都是手工放进插件目录的本地安装，
   * 没有 plugins:catalog-tags 记录）。这种情况下筛选条只剩「未标注」，得说清楚。
   */
  function renderHint() {
    if (view.tagCount > 0 || view.total === 0) return null
    return h(
      'div',
      { class: 'etf-hint', 'data-role': 'hint' },
      '宿主没有提供任何插件标签：目前只能按「未标注」筛选。从「在线插件」安装过的插件会带有索引里的标签。'
    )
  }

  /** 分组元信息：共几个 + 已选几个 */
  function groupMetaText(group) {
    const selected = group.chips.filter((chip) => chip.selected).length
    const total = group.chips.length
    return selected ? `已选 ${selected} / ${total}` : `${total} 项`
  }

  function renderGroup(group) {
    const collapsed = isGroupCollapsed(group.id)
    return h('div', { class: `etf-group${collapsed ? ' is-collapsed' : ''}`, 'data-role': 'group', 'data-group': group.id }, [
      h(
        'button',
        {
          class: 'etf-group-head',
          type: 'button',
          title: collapsed ? `展开「${group.title}」` : `收起「${group.title}」`,
          'data-action': 'toggle-group',
          'data-group': group.id,
          'aria-expanded': collapsed ? 'false' : 'true',
          onClick: () => toggleGroupCollapsed(group.id)
        },
        [
          icon(collapsed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN, 12),
          h('span', { class: 'etf-group-title' }, group.title),
          h('span', { class: 'etf-group-meta' }, groupMetaText(group))
        ]
      ),
      collapsed
        ? null
        : h(
            'div',
            { class: 'etf-chips' },
            group.chips.map((chip) => renderChip(chip))
          )
    ])
  }

  function renderGroups(groups, role) {
    if (!groups.length) return null
    return h(
      'div',
      { class: 'etf-groups', 'data-role': role || 'groups' },
      groups.map((group) => renderGroup(group))
    )
  }

  const TagFilterBar = defineComponent({
    name: 'TagFilterBar',
    setup() {
      return () => {
        if (!view.visible || !settings.enableFilterBar) return null
        return h('div', { class: `etf-bar${view.barFocused ? ' is-focused' : ''}` }, [
          h('div', { class: 'etf-bar-head' }, [
            h('span', { class: 'etf-bar-title' }, [icon(ICON_FILTER, 13), h('span', {}, '筛选插件')]),
            view.expanded ? null : renderSelectedSummary(),
            h('div', { class: 'etf-bar-tools' }, [renderExpandButton(), renderModeSwitch(), renderClearButton()])
          ]),
          renderStatus(),
          view.expanded ? renderGroups(view.groups) : null,
          view.noMatch ? renderEmptyState() : renderHint()
        ])
      }
    }
  })

  /* ---------- 独立页面：标签总览 + 自定义组 + 状态 ---------- */

  function formatTime(ts) {
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return '未知时间'
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  const VIEW_LABELS = { marketplace: '在线插件视图', installed: '已安装视图' }

  function catalogMetaText() {
    if (!catalog.total) return '暂无数据'
    const where = VIEW_LABELS[catalog.source] || '插件面板'
    if (catalog.fromSnapshot) {
      return `上次采集：${catalog.at ? formatTime(catalog.at) : '未知时间'} · ${where} · ${catalog.total} 个插件`
    }
    return `实时：${where} · ${catalog.total} 个插件`
  }

  function kv(label, value) {
    return h('div', { class: 'etf-kv-row', key: label }, [
      h('span', { class: 'etf-kv-key' }, label),
      h('span', { class: 'etf-kv-val' }, value)
    ])
  }

  const TagFilterPage = defineComponent({
    name: 'TagFilterPage',
    setup() {
      const draft = reactive({ name: '' })
      const renames = reactive({})

      const refresh = () => {
        sync()
        if (!liveEntities.length) {
          toast('info', '请先打开「设置 → 插件」页面，插件会自动采集标签')
        } else {
          toast('success', `已采集：${liveEntities.length} 个插件 / ${catalog.chipCount} 个条件`)
        }
      }

      const copyDiagnostics = async () => {
        const payload = buildDiagnostics()
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(payload)
            toast('success', '诊断信息已复制')
          } else {
            log(payload)
            toast('warning', '当前环境不支持剪贴板，诊断信息已输出到控制台')
          }
        } catch (error) {
          log('复制诊断失败', error)
          toast('warning', '复制失败，诊断信息已输出到控制台')
        }
      }

      const b = (text, action, onClick, iconPath) =>
        h('button', { class: 'etf-btn', type: 'button', 'data-action': action, onClick }, [
          icon(iconPath, 13),
          h('span', {}, text)
        ])

      const createGroup = () => {
        const group = createGroupFromSelection(draft.name)
        if (group) draft.name = ''
      }

      /** 一行自定义组：名字可改、成员可单个移除、成员可用当前筛选整体覆盖 */
      const renderGroupRow = (group) =>
        h('div', { class: 'etf-group-row', 'data-role': 'custom-group', 'data-group': group.id }, [
          h('div', { class: 'etf-group-row-head' }, [
            h('input', {
              class: 'etf-input etf-input-name',
              type: 'text',
              value: renames[group.id] === undefined ? group.name : renames[group.id],
              placeholder: '组名',
              'data-role': 'group-name',
              'data-group': group.id,
              onInput: (event) => {
                renames[group.id] = String((event.target && event.target.value) || '')
              },
              onChange: (event) => {
                renameGroup(group.id, String((event.target && event.target.value) || ''))
                delete renames[group.id]
              }
            }),
            h(
              'button',
              {
                class: 'etf-chip etf-chip-mini',
                type: 'button',
                title: '把当前筛选里的标签设为这个组的成员（替换原成员）',
                'data-action': 'group-replace',
                'data-group': group.id,
                onClick: () => replaceGroupMembers(group.id)
              },
              '用当前筛选覆盖'
            ),
            h(
              'button',
              {
                class: 'etf-chip etf-chip-mini is-danger',
                type: 'button',
                title: '删除这个组（不会影响当前筛选）',
                'data-action': 'group-remove',
                'data-group': group.id,
                onClick: () => removeGroup(group.id)
              },
              [icon(ICON_TRASH, 11), h('span', {}, '删除')]
            )
          ]),
          h(
            'div',
            { class: 'etf-group-row-tags' },
            group.tags.map((key) =>
              h(
                'button',
                {
                  key,
                  class: `etf-chip etf-chip-mini${(selection.tags || []).indexOf(key) >= 0 ? ' is-on' : ''}`,
                  type: 'button',
                  title: `点击${(selection.tags || []).indexOf(key) >= 0 ? '取消' : '选中'}「${labels.get(key) || key}」；点右侧 × 从组里移除`,
                  'data-action': 'group-member',
                  'data-group': group.id,
                  'data-member': key,
                  onClick: () => toggleTag(key)
                },
                [
                  h('span', { class: 'etf-chip-label' }, labels.get(key) || key),
                  h(
                    'span',
                    {
                      class: 'etf-chip-remove',
                      title: '从组里移除',
                      onClick: (event) => {
                        if (event && event.stopPropagation) event.stopPropagation()
                        removeGroupMember(group.id, key)
                      }
                    },
                    '×'
                  )
                ]
              )
            )
          )
        ])

      return () =>
        h('div', { class: 'etf-page' }, [
          h('section', { class: 'etf-hero' }, [
            h('h2', { class: 'etf-hero-title' }, [icon(ICON_FILTER, 18), h('span', {}, '插件标签筛选')]),
            h(
              'p',
              { class: 'etf-hero-desc' },
              '打开「设置 → 插件」后，插件网格的上方会出现一条筛选条：标签、安装状态、启用状态按组排列，' +
                '点选即时过滤列表，「清除筛选」恢复完整列表。下面这份总览与筛选条共享同一份选择。'
            ),
            h('div', { class: 'etf-hero-actions' }, [
              b('定位筛选条', 'locate', () => void focusBar(), ICON_SEARCH),
              b('重新采集', 'refresh', refresh, ICON_LAYERS),
              b('复制诊断', 'copy-diagnostics', () => void copyDiagnostics())
            ])
          ]),

          h('section', { class: 'etf-card' }, [
            h('div', { class: 'etf-card-head' }, [
              h('h3', { class: 'etf-card-title' }, '筛选总览'),
              h('span', { class: 'etf-card-meta', 'data-role': 'catalog-meta' }, catalogMetaText())
            ]),
            catalog.groups.length
              ? renderGroups(catalog.groups, 'catalog-groups')
              : h(
                  'p',
                  { class: 'etf-page-empty', 'data-role': 'catalog-empty' },
                  '还没有采集到条件。请先打开「设置 → 插件」页面。'
                ),
            h('div', { class: 'etf-page-tools' }, [renderModeSwitch('etf-seg-lg'), renderClearButton('etf-clear-lg', '清除筛选')])
          ]),

          h('section', { class: 'etf-card' }, [
            h('div', { class: 'etf-card-head' }, [
              h('h3', { class: 'etf-card-title' }, '自定义标签组'),
              h('span', { class: 'etf-card-meta' }, `${customGroups.length} 个组`)
            ]),
            h(
              'p',
              { class: 'etf-page-desc' },
              '把常用的几个标签打包成一个组，点一下就能同时选中它们。做法：先在筛选条里选好标签，回这里点「新建」。'
            ),
            h('div', { class: 'etf-group-create' }, [
              h('input', {
                class: 'etf-input',
                type: 'text',
                value: draft.name,
                placeholder: '给组起个名字（如：歌词相关）',
                'data-role': 'new-group-name',
                onInput: (event) => {
                  draft.name = String((event.target && event.target.value) || '')
                },
                onKeydown: (event) => {
                  if (event && event.key === 'Enter') createGroup()
                }
              }),
              h(
                'button',
                {
                  class: 'etf-btn etf-btn-primary',
                  type: 'button',
                  'data-action': 'group-create',
                  onClick: createGroup
                },
                [icon(ICON_PLUS, 13), h('span', {}, `新建（当前已选 ${(selection.tags || []).length} 个标签）`)]
              )
            ]),
            customGroups.length
              ? h('div', { class: 'etf-group-list' }, customGroups.map((group) => renderGroupRow(group)))
              : h('p', { class: 'etf-page-empty', 'data-role': 'groups-empty' }, '还没有自定义组。')
          ]),

          h('section', { class: 'etf-card' }, [
            h('h3', { class: 'etf-card-title' }, '当前状态'),
            h('div', { class: 'etf-kv' }, [
              kv('面板筛选条', settings.enableFilterBar ? '已开启' : '已关闭'),
              kv('数据来源', view.source === 'live' ? '实时读取插件面板' : '上次采集的快照'),
              kv('插件数量', String(view.total)),
              kv('标签数量', `${view.tagCount}${view.untaggedCount ? ` + ${view.untaggedCount} 个未标注` : ''}`),
              kv('分组数量', String(view.groupCount)),
              kv(
                '已选条件',
                view.selectedChips.length ? view.selectedChips.map((chip) => chip.label).join('、') : '无'
              ),
              kv('匹配方式', MATCH_MODES[view.mode] ? MATCH_MODES[view.mode].label : view.mode)
            ])
          ])
        ])
    }
  })

  /* ---------- 设置面板 ---------- */

  function renderToggle(checked, onToggle, title) {
    const on = !!checked
    const fire = (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      onToggle(!on)
    }
    return h(
      'span',
      {
        class: 'etf-switch',
        role: 'switch',
        tabindex: '0',
        'aria-checked': on ? 'true' : 'false',
        'data-on': on ? 'true' : 'false',
        title: title || (on ? '点击关闭' : '点击开启'),
        onClick: fire,
        onKeydown: (event) => {
          if (event && (event.key === 'Enter' || event.key === ' ')) fire(event)
        }
      },
      [h('span', { class: 'etf-switch-knob' })]
    )
  }

  function renderSwitchRow(title, desc, checked, onChange) {
    const on = !!checked
    return h('div', { class: `etf-switch-row${on ? ' is-on' : ''}` }, [
      h('div', { class: 'etf-switch-text' }, [
        h('div', { class: 'etf-switch-title' }, [
          h('span', {}, title),
          h('span', { class: `etf-state-chip${on ? ' is-on' : ''}` }, on ? '已开启' : '已关闭')
        ]),
        h('div', { class: 'etf-switch-desc' }, desc)
      ]),
      renderToggle(on, onChange)
    ])
  }

  const SettingsPanel = defineComponent({
    name: 'TagFilterSettings',
    setup() {
      const save = (key, value) => void updateSetting(key, value)
      return () =>
        h('div', { class: 'etf-settings' }, [
          renderSwitchRow(
            '在插件面板显示筛选条',
            '在「设置 → 插件」页面的插件网格上方注入筛选条；关闭后不再过滤，卡片立即恢复完整列表',
            settings.enableFilterBar,
            (value) => save('enableFilterBar', value)
          ),
          renderSwitchRow(
            '侧边栏显示「标签筛选」入口',
            '关闭后只保留面板内的筛选条，侧边栏少一个入口（切换后立即生效）',
            settings.showSidebarEntry,
            (value) => save('showSidebarEntry', value)
          ),
          renderSwitchRow(
            '记住筛选状态',
            '把已选条件、分组折叠状态与自定义组写进插件存储，重启主程序后恢复',
            settings.persistSelection,
            (value) => save('persistSelection', value)
          ),
          renderSwitchRow(
            '在标签上显示插件数量',
            '每个标签后面显示当前视图里带该标签的插件数（快捷组另外显示「已选/成员数」）',
            settings.showCounts,
            (value) => save('showCounts', value)
          ),
          renderSwitchRow(
            '显示「安装状态 / 启用状态」',
            '除标签外，再按安装状态（已安装/未安装/可更新）与启用状态（已启用/未启用）筛选；' +
              '某一维度在当前视图里只有一种取值时，该组会自动隐藏，不占地方',
            settings.showFacets,
            (value) => save('showFacets', value)
          ),
          renderSwitchRow(
            '同时纳入「能力标签」',
            '除目录标签外，额外聚合由 manifest.capabilities 生成的能力标签（如「网络」「本地文件」），单独归到「能力标签」一组',
            settings.includeFeatureTags,
            (value) => save('includeFeatureTags', value)
          ),
          renderSwitchRow('调试日志', '在开发者控制台输出详细日志', settings.debug, (value) =>
            save('debug', value)
          ),
          h('div', { class: 'etf-field' }, [
            h('span', { class: 'etf-field-label' }, '默认匹配方式（只影响标签维度）'),
            h(
              'div',
              { class: 'etf-seg etf-seg-lg', role: 'group' },
              Object.values(MATCH_MODES).map((item) =>
                h(
                  'button',
                  {
                    key: item.id,
                    class: `etf-seg-btn${settings.defaultMode === item.id ? ' is-on' : ''}`,
                    type: 'button',
                    title: item.title,
                    'data-default-mode': item.id,
                    onClick: () => save('defaultMode', item.id)
                  },
                  item.label
                )
              )
            )
          ])
        ])
    }
  })

  async function updateSetting(key, value) {
    settings[key] = value
    if (key === 'enableFilterBar' || key === 'includeFeatureTags' || key === 'showFacets') {
      sync()
    } else if (key === 'showSidebarEntry') {
      applySidebarEntry(value)
    } else if (key === 'defaultMode' && (selection.tags || []).length === 0) {
      mode = MATCH_MODES[value] ? value : DEFAULT_SETTINGS.defaultMode
      recompute()
    } else {
      recompute()
    }
    await persist()
  }

  /* ---------- 诊断 ---------- */

  function domSnapshot() {
    if (typeof document === 'undefined') return { available: false }
    const grids = Array.from(document.querySelectorAll(DOM.grid))
    const cards = Array.from(document.querySelectorAll(DOM.card))
    return {
      available: true,
      grids: grids.length,
      busyGrids: grids.filter(isBusyGrid).length,
      cards: cards.length,
      marketplaceCards: cards.filter((card) => hasClass(card, MARKETPLACE_CARD_CLASS)).length,
      cardsWithId: cards.filter((card) => !!stripIdPrefix(textOf(cardQuery(card, DOM.cardId)))).length,
      cardsWithTags: cards.filter((card) => !!cardQuery(card, DOM.tags)).length,
      cardsWithFeatureTags: cards.filter((card) => !!cardQuery(card, DOM.featureTags)).length,
      cardsWithStatusBadge: cards.filter((card) => !!cardQuery(card, DOM.statusBadge)).length,
      contents: document.querySelectorAll(DOM.content).length,
      hosts: document.querySelectorAll('.etf-host').length,
      view: describeView()
    }
  }

  function buildDiagnostics() {
    return JSON.stringify(
      {
        plugin: 'tag-filter',
        at: new Date().toISOString(),
        settings: { ...settings },
        selection: normalizeSelection(selection),
        mode,
        groups: customGroups.map((group) => ({ id: group.id, name: group.name, tags: group.tags })),
        ui: { expanded: view.expanded, groupCollapsed: { ...view.groupCollapsed } },
        dom: domSnapshot(),
        live: {
          entities: liveEntities.length,
          elements: liveEntities.reduce((n, entity) => n + (entity.elements ? entity.elements.length : 0), 0)
        },
        snapshot: { at: snapshot.at, source: snapshot.source, items: snapshotEntities().length },
        cards: liveEntities.slice(0, 80).map((entity) => ({
          id: entity.id,
          name: entity.name,
          tags: entity.tags.map((tag) => tag.label),
          facets: { install: pickFacet(entity, 'install'), enabled: pickFacet(entity, 'enabled') },
          elements: entity.elements ? entity.elements.length : 0,
          hidden: !matchesEntity(entity, selection, mode)
        }))
      },
      null,
      2
    )
  }

  /* ---------- 侧边栏入口 ---------- */

  let sidebarDispose = null

  function applySidebarEntry(enabled) {
    if (enabled) {
      if (sidebarDispose) return true
      try {
        const dispose =
          ctx.ui && ctx.ui.sidebar && typeof ctx.ui.sidebar.addItem === 'function'
            ? ctx.ui.sidebar.addItem({
                id: 'tag-filter-entry',
                title: '标签筛选',
                icon: 'tabler:filter',
                pageId: 'tag-filter',
                section: 'plugins',
                sectionTitle: '插件',
                order: 40
              })
            : null
        sidebarDispose = typeof dispose === 'function' ? dispose : () => {}
        log('侧边栏入口已注册')
        return true
      } catch (error) {
        log('注册侧边栏入口失败', error)
        sidebarDispose = null
        return false
      }
    }

    if (typeof sidebarDispose === 'function') {
      try {
        sidebarDispose()
      } catch (error) {
        log('移除侧边栏入口失败', error)
      }
    }
    sidebarDispose = null
    return true
  }

  /* ---------- 启动 ---------- */

  try {
    applyLoaded(await ctx.storage.get(STORAGE_KEY))
  } catch (error) {
    log('读取配置失败，使用默认值', error)
    applyLoaded(null)
  }

  ctx.ui.addPage({
    id: 'tag-filter',
    title: '标签筛选',
    icon: 'tabler:filter',
    component: TagFilterPage
  })

  applySidebarEntry(settings.showSidebarEntry)

  ctx.ui.settings.define({
    title: '插件标签筛选 设置',
    description: '筛选条的显示、分组维度与匹配方式。',
    component: SettingsPanel
  })

  ctx.commands.register('clear-tag-filter', () => {
    if (selectionCount(selection) === 0) {
      toast('info', '当前没有筛选条件')
      return
    }
    clearSelection()
    toast('success', '已清除筛选条件')
  })
  ctx.commands.register('toggle-tag-filter-bar', async () => {
    await updateSetting('enableFilterBar', !settings.enableFilterBar)
    toast('success', settings.enableFilterBar ? '已开启筛选条' : '已关闭筛选条')
  })
  ctx.commands.register('toggle-tag-filter-expand', () => {
    toggleExpanded()
    toast('success', view.expanded ? '已展开筛选条件' : '已收起筛选条件')
  })

  startWatching()
  sync()

  ctx.dispose(() => {
    disposed = true
    if (observer) {
      try {
        observer.disconnect()
      } catch (error) {
        log('停止 DOM 监听失败', error)
      }
      observer = null
    }
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = null
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    dropAllHosts()
    restoreAll()
    if (typeof sidebarDispose === 'function') sidebarDispose()
    sidebarDispose = null
  })

  log('已启用')
}

export async function deactivate() {
  // 页面、设置面板、命令、注入的样式由宿主统一回收；
  // 被隐藏的卡片在 ctx.dispose 回调里已经还原，这里无需额外处理。
}

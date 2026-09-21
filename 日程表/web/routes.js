// 路由表：hash 路由，免服务器 rewrite。nav=false 的页面不出现在导航里。
export const ROUTES = [
  { key: 'home', path: '', title: '任务舱', subtitle: 'PERSONAL MISSION CONTROL', icon: 'home', nav: true },
  { key: 'timetable', path: 'timetable', title: '课表', subtitle: 'SEMESTER TIMETABLE', icon: 'timetable', nav: true },
  { key: 'tasks', path: 'tasks', title: '日程', subtitle: 'SCHEDULE & DEADLINES', icon: 'tasks', nav: true },
  { key: 'research', path: 'research', title: '科研', subtitle: 'RESEARCH MILESTONES', icon: 'research', nav: true },
  { key: 'workout', path: 'workout', title: '健身', subtitle: 'TRAINING LOG', icon: 'workout', nav: true },
  { key: 'settings', path: 'settings', title: '设置', subtitle: 'SEMESTER SETUP & DATA', icon: 'settings', nav: false },
];

const BY_KEY = new Map(ROUTES.map((route) => [route.key, route]));

export function routeByKey(key) {
  return BY_KEY.get(key) ?? null;
}

export function href(route, sub = '') {
  return `#/${route.path}${sub}`;
}

/** '#/research/uuid?x=1' → { key:'research', sub:'uuid', query } */
export function parseHash(raw) {
  const value = String(raw ?? '').replace(/^#\/?/, '');
  const [pathPart, queryPart] = value.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const key = segments[0] === '' || segments[0] === undefined ? 'home' : segments[0];
  const route = BY_KEY.get(key);
  return {
    key: route ? key : 'home',
    unknown: !route,
    sub: segments[1] ?? '',
    query: new URLSearchParams(queryPart ?? ''),
  };
}

export const navRoutes = ROUTES.filter((route) => route.nav);

/** 数字快捷键 1–6：五个导航页 + 设置 */
export const keyBindings = [...navRoutes, BY_KEY.get('settings')].map((route, index) => [String(index + 1), route.key]);

// 本地预览用的演示数据：只描述"一个人真实的一学期"，不含任何统计结果。
// 与前端渲染无关，dev/ 目录不进发布包。
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

function row(columns, values, createdDaysAgo = 7) {
  const base = Object.fromEntries(columns.map((column) => [column, null]));
  const out = {
    ...base, ...values,
    id: values.id ?? crypto.randomUUID(),
    updated_at: values.updated_at ?? iso(Math.max(0, createdDaysAgo - 1)),
  };
  // semester_config 没有 created_at 列，多塞一个字段会让 validateRow 判为未知字段
  if (columns.includes('created_at')) out.created_at = values.created_at ?? iso(createdDaysAgo);
  return out;
}

const COLUMNS = {
  semester_config: ['id', 'start_date', 'total_weeks', 'periods', 'updated_at'],
  courses: ['id', 'name', 'teacher', 'location', 'day_of_week', 'start_time', 'end_time', 'week_type', 'start_week', 'end_week', 'color', 'note', 'sort', 'created_at', 'updated_at'],
  tasks: ['id', 'title', 'due_date', 'due_time', 'duration_min', 'category', 'note', 'done', 'done_at', 'created_at', 'updated_at'],
  research_projects: ['id', 'name', 'description', 'status', 'sort', 'created_at', 'updated_at'],
  milestones: ['id', 'project_id', 'title', 'note', 'target_date', 'status', 'progress', 'manual_progress', 'sort', 'created_at', 'updated_at'],
  subtasks: ['id', 'milestone_id', 'title', 'done', 'sort', 'created_at', 'updated_at'],
  workouts: ['id', 'workout_date', 'type', 'duration_min', 'status', 'note', 'created_at', 'updated_at'],
};

const PERIODS = [
  { label: '第 1 节', start: '08:00', end: '08:45', kind: 'class' },
  { label: '第 2 节', start: '08:55', end: '09:40', kind: 'class' },
  { label: '第 3 节', start: '10:00', end: '10:45', kind: 'class' },
  { label: '第 4 节', start: '10:55', end: '11:40', kind: 'class' },
  { label: '午休', start: '12:00', end: '14:00', kind: 'break' },
  { label: '第 5 节', start: '14:00', end: '14:45', kind: 'class' },
  { label: '第 6 节', start: '14:55', end: '15:40', kind: 'class' },
  { label: '第 7 节', start: '16:00', end: '16:45', kind: 'class' },
  { label: '第 8 节', start: '16:55', end: '17:40', kind: 'class' },
  { label: '晚自习', start: '19:00', end: '20:40', kind: 'class' },
];

const COURSES = [
  ['数据结构与算法', '王立群', 'A302', 1, '08:00', '09:40', 'all', 1, 16, '#3DD6F5'],
  ['毛泽东思想和中国特色社会主义理论体系概论', '李晓丹', '主楼 201', 1, '10:00', '11:40', 'all', 1, 16, '#FF8A3D'],
  ['高等数学（下）', '张一鸣', 'B105', 2, '08:55', '10:30', 'all', 1, 18, '#A78BFA'],
  ['计算机网络', '陈致远', 'A415', 2, '14:00', '15:40', 'odd', 1, 16, '#4ADE80'],
  ['数据库系统原理', '刘敏', 'A302', 3, '10:00', '11:40', 'all', 1, 12, '#38BDF8'],
  ['大学英语（四）', 'Emily Zhou', '外语楼 306', 3, '14:55', '16:30', 'even', 2, 16, '#FACC15'],
  ['面向对象程序设计', '赵鹏', '实验楼 C201', 4, '08:00', '09:40', 'all', 1, 16, '#3DD6F5'],
  ['线性代数', '孙华', 'B204', 4, '16:00', '17:40', 'odd', 1, 14, '#A78BFA'],
  ['软件工程导论', '周建国', 'A110', 5, '08:55', '10:30', 'all', 1, 8, '#8FA3C0'],
  ['人工智能基础', '吴清', '实验楼 C305', 5, '14:00', '15:40', 'even', 2, 16, '#4ADE80'],
  ['体育（游泳）', '马强', '风雨操场', 5, '16:00', '17:40', 'all', 1, 18, '#FF8A3D'],
  ['操作系统', '郑海涛', 'A415', 6, '10:00', '11:40', 'all', 3, 18, '#38BDF8'],
  ['创新创业实践', '黄晓', '创客空间', 7, '19:00', '20:40', 'odd', 5, 15, '#FACC15'],
];

/** 相对"今天"生成，任何一天打开预览都是一份合理的在读学期。 */
export function buildSeed(today = new Date()) {
  const local = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const shifted = (days) => {
    const copy = new Date(today);
    copy.setHours(0, 0, 0, 0);
    copy.setDate(copy.getDate() - days);
    return local(copy);
  };
  const dow = today.getDay() === 0 ? 7 : today.getDay();
  const monday = new Date(today);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - (dow - 1) - 28); // 让今天正好落在第 5 周
  const startDate = local(monday);

  const semester = row(COLUMNS.semester_config, { start_date: startDate, total_weeks: 18, periods: PERIODS }, 60);
  const courses = COURSES.map(([name, teacher, location, day_of_week, start_time, end_time, week_type, start_week, end_week, color], index) => row(
    COLUMNS.courses,
    { name, teacher, location, day_of_week, start_time, end_time, week_type, start_week, end_week, color, note: index === 0 ? '期中考第 9 周' : null, sort: index },
    55,
  ));

  const tasks = [
    ['数据结构：第 4 章习题', shifted(1), '23:59', 45, '作业', true],
    ['操作系统实验报告', shifted(0), '18:00', 90, '作业', false],
    ['提交课程论文选题', shifted(0), '12:00', 20, '科研', false],
    ['预约游泳池', shifted(0), null, 10, '生活', false],
    ['复现 Transformer 基线', shifted(2), '22:00', 180, '科研', false],
    ['高等数学期中复习', shifted(3), null, 120, '作业', false],
    ['报销实验器材', shifted(5), null, 30, '其它', false],
    ['和导师组会汇报', shifted(-1), '09:30', 60, '科研', false],
    ['整理健身数据', null, null, null, '生活', false],
    ['图书馆还书', shifted(4), null, 15, '生活', true],
  ].map(([title, due_date, due_time, duration_min, category, done], index) => row(
    COLUMNS.tasks,
    {
      title, due_date, due_time, duration_min, category,
      note: index === 4 ? '失败就跑小样本先验证' : null,
      done, done_at: done ? iso(1) : null,
    },
    12 - index,
  ));

  const projectA = row(COLUMNS.research_projects, {
    name: '基于深度学习的目标检测加速', description: '面向嵌入式平台的轻量检测网络，目标是 mAP 不掉的前提下把推理延迟压到 30ms 以内。', status: 'active', sort: 0,
  }, 40);
  const projectB = row(COLUMNS.research_projects, {
    name: '校园能耗数据异常检测', description: '和后勤合作的横向课题，先做数据清洗与基线。', status: 'not_started', sort: 1,
  }, 18);

  const milestoneA = row(COLUMNS.milestones, { project_id: projectA.id, title: '数据集整理与标注', note: '500 张校园场景图', target_date: shifted(-3), status: 'active', progress: 25, manual_progress: false, sort: 0 }, 38);
  const milestoneB = row(COLUMNS.milestones, { project_id: projectA.id, title: '基线模型复现', target_date: shifted(-12), status: 'active', progress: 67, manual_progress: false, sort: 1 }, 36);
  const milestoneC = row(COLUMNS.milestones, { project_id: projectA.id, title: '嵌入式部署与延迟测试', target_date: shifted(-25), status: 'not_started', progress: 15, manual_progress: true, sort: 2 }, 30);
  const milestoneD = row(COLUMNS.milestones, { project_id: projectB.id, title: '能耗数据接入', target_date: shifted(-8), status: 'blocked', progress: 0, manual_progress: false, sort: 0 }, 16);

  const subtasks = [
    [milestoneA, '写采集脚本', true, 0],
    [milestoneA, '标注 500 张图', false, 1],
    [milestoneA, '数据清洗管线', false, 2],
    [milestoneA, '划分训练/验证集', false, 3],
    [milestoneB, '跑通 YOLOv8 官方实现', true, 0],
    [milestoneB, '对齐指标口径', true, 1],
    [milestoneB, '记录首轮结果', false, 2],
    [milestoneD, '向后勤要电表台账', false, 0],
  ].map(([parent, title, done, sort], index) => row(
    COLUMNS.subtasks, { milestone_id: parent.id, title, done, sort }, 20 - index,
  ));

  const workouts = [];
  for (let back = 0; back < 30; back += 1) {
    const date = shifted(back);
    const dowOf = ((Date.parse(`${date}T00:00:00Z`) / 86400000 + 4) % 7) || 7;
    const weekday = dowOf <= 5;
    if (back === 3) { workouts.push(row(COLUMNS.workouts, { workout_date: date, type: '跑步', duration_min: 0, status: 'missed', note: '下雨' }, back)); continue; }
    if (!weekday && back % 7 !== 2) continue;
    const plan = back % 7 < 3 ? ['力量', 45] : back % 7 < 5 ? ['跑步', 30] : ['拉伸', 20];
    workouts.push(row(COLUMNS.workouts, {
      workout_date: date, type: plan[0],
      duration_min: plan[1] + (back % 3) * 5,
      status: back % 11 === 5 ? 'partial' : 'done',
      note: back % 9 === 0 ? '状态一般' : null,
    }, back));
  }

  return {
    semester_config: [semester],
    courses,
    tasks,
    research_projects: [projectA, projectB],
    milestones: [milestoneA, milestoneB, milestoneC, milestoneD],
    subtasks,
    workouts,
  };
}

export { COLUMNS as SEED_COLUMNS, PERIODS as SEED_PERIODS };

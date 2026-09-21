-- v1 schema · 个人日程管理系统（PRD 7.2）
-- 只使用平台迁移接口支持的受限子集：
--   列类型 uuid / text / integer / boolean / timestamptz / jsonb
--   约束 NULL / NOT NULL / PRIMARY KEY / UNIQUE
--   索引为普通列索引，无 ASC/DESC、无表达式、无谓词、无 schema 前缀名
--   不使用外键、DEFAULT、CHECK、生成列（完整性由 Function 校验）
-- 日历日期存 text('YYYY-MM-DD')，时刻存 text('HH:MM')

CREATE TABLE app.semester_config (
  id uuid PRIMARY KEY,
  start_date text NOT NULL,
  total_weeks integer NOT NULL,
  periods jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE app.courses (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  teacher text,
  location text,
  day_of_week integer NOT NULL,
  start_time text NOT NULL,
  end_time text NOT NULL,
  week_type text NOT NULL,
  start_week integer NOT NULL,
  end_week integer NOT NULL,
  color text,
  note text,
  sort integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX courses_day_idx ON app.courses (day_of_week);

CREATE TABLE app.tasks (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  due_date text,
  due_time text,
  duration_min integer,
  category text,
  note text,
  done boolean NOT NULL,
  done_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX tasks_due_idx ON app.tasks (due_date);

CREATE TABLE app.research_projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text,
  status text NOT NULL,
  sort integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE app.milestones (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  title text NOT NULL,
  note text,
  target_date text,
  status text NOT NULL,
  progress integer NOT NULL,
  manual_progress boolean NOT NULL,
  sort integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX milestones_project_idx ON app.milestones (project_id);

CREATE TABLE app.subtasks (
  id uuid PRIMARY KEY,
  milestone_id uuid NOT NULL,
  title text NOT NULL,
  done boolean NOT NULL,
  sort integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX subtasks_milestone_idx ON app.subtasks (milestone_id);

CREATE TABLE app.workouts (
  id uuid PRIMARY KEY,
  workout_date text NOT NULL,
  type text NOT NULL,
  duration_min integer NOT NULL,
  status text NOT NULL,
  note text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX workouts_date_idx ON app.workouts (workout_date);

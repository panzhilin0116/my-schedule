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

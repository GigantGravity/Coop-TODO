-- =====================================================================
-- Update 002: Unteraufgaben, Prioritäten, Reihenfolge per Drag & Drop
-- Nur für bestehende Installationen: im Supabase "SQL Editor" einmal ausführen.
-- (Neue Installationen führen einfach supabase/schema.sql aus, das enthält alles.)
-- =====================================================================

-- Reihenfolge: Kommazahlen erlauben, damit beim Verschieben nur ein Eintrag geändert werden muss
alter table public.lists alter column position type double precision;

-- Priorität (0 = niedrig, 1 = normal, 2 = hoch) und Reihenfolge für Aufgaben
alter table public.tasks
  add column priority smallint not null default 1 check (priority between 0 and 2),
  add column position double precision not null default 0;

update public.tasks set position = id;

-- Unteraufgaben
create table public.subtasks (
  id          bigint generated always as identity primary key,
  task_id     bigint not null references public.tasks (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 300),
  done        boolean not null default false,
  position    double precision not null default 0,
  created_at  timestamptz not null default now()
);

create index subtasks_task_id_idx on public.subtasks (task_id);

alter table public.subtasks enable row level security;
create policy "Unteraufgaben: alles für Angemeldete" on public.subtasks for all to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.subtasks;

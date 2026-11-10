-- =====================================================================
-- Datenbank-Schema für die gemeinsame To-do-Liste
-- Im Supabase-Dashboard unter "SQL Editor" einfügen und ausführen.
-- =====================================================================

-- Profile: ein Eintrag pro Benutzer (Anzeigename)
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null
);

-- Listen / Kategorien (z. B. "Bauen", "Farmen", ...)
create table public.lists (
  id          bigint generated always as identity primary key,
  name        text not null check (char_length(name) between 1 and 100),
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

-- Aufgaben
create table public.tasks (
  id           bigint generated always as identity primary key,
  list_id      bigint not null references public.lists (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 300),
  note         text,
  done         boolean not null default false,
  assigned_to  uuid references public.profiles (id) on delete set null,
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  done_at      timestamptz
);

create index tasks_list_id_idx on public.tasks (list_id);

-- ---------------------------------------------------------------------
-- Profil automatisch anlegen, wenn sich jemand registriert
-- ---------------------------------------------------------------------
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------
-- Zugriffsschutz (Row Level Security)
-- Nur angemeldete Benutzer dürfen lesen und schreiben.
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.lists    enable row level security;
alter table public.tasks    enable row level security;

create policy "Profile lesen"          on public.profiles for select to authenticated using (true);
create policy "Eigenes Profil ändern"  on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "Listen: alles für Angemeldete"   on public.lists for all to authenticated using (true) with check (true);
create policy "Aufgaben: alles für Angemeldete" on public.tasks for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------
-- Echtzeit-Updates für Listen und Aufgaben aktivieren
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.lists, public.tasks, public.profiles;

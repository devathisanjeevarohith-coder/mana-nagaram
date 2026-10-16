-- Run in Supabase SQL Editor after creating the project.
-- New self-registered accounts receive citizen role; staff is granted manually by an owner.
create or replace function public.assign_citizen_role()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"citizen"}'::jsonb
  where id = new.id;
  return new;
end;
$$;

drop trigger if exists mana_nagaram_citizen_role on auth.users;
create trigger mana_nagaram_citizen_role after insert on auth.users
for each row execute procedure public.assign_citizen_role();

-- To authorize a staff account, run as project owner and replace the email:
-- update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"staff"}'::jsonb where email = 'staff@example.com';

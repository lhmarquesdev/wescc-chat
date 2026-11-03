-- Arquivos: pastas compartilhadas com permissão por pasta (papel, canal/operação ou pessoa).

-- Pasta. parent_id nulo = pasta principal. inherit = herda as permissões da pasta de cima (desligado, só valem as
-- permissões desta pasta). trashed_at: está na lixeira (a subárvore inteira some junto).
CREATE TABLE drive_folders (
  id          text PRIMARY KEY,
  parent_id   text REFERENCES drive_folders(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  color       text,
  inherit     boolean NOT NULL DEFAULT true,
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  trashed_at  timestamptz,
  trashed_by  text REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX drive_folders_parent_idx ON drive_folders (parent_id);
-- Nome único entre as irmãs ativas (sem diferenciar maiúsculas).
CREATE UNIQUE INDEX drive_folders_name_uq ON drive_folders (coalesce(parent_id, ''), lower(name)) WHERE trashed_at IS NULL;

-- Arquivo, sempre dentro de uma pasta. storage_path no mesmo diretório dos anexos (AAAA/MM/<id>).
CREATE TABLE drive_files (
  id           text PRIMARY KEY,
  folder_id    text NOT NULL REFERENCES drive_folders(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type         text NOT NULL,
  size         bigint NOT NULL,
  storage_path text NOT NULL,
  uploaded_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  trashed_at   timestamptz,
  trashed_by   text REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX drive_files_folder_idx ON drive_files (folder_id);
CREATE UNIQUE INDEX drive_files_name_uq ON drive_files (folder_id, lower(name)) WHERE trashed_at IS NULL;

-- Quem acessa a pasta. subject_type: role (papel global), room (membros de um canal ou grupo), user (uma pessoa).
-- level: 1 ver e baixar · 2 editar (enviar, renomear, mover, criar subpastas) · 3 gerenciar (também compartilhar).
CREATE TABLE drive_acl (
  folder_id    text NOT NULL REFERENCES drive_folders(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('role', 'room', 'user')),
  subject_id   text NOT NULL,
  level        smallint NOT NULL CHECK (level BETWEEN 1 AND 3),
  granted_by   text REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (folder_id, subject_type, subject_id)
);
CREATE INDEX drive_acl_subject_idx ON drive_acl (subject_type, subject_id);

-- Histórico de cada pasta (envios, downloads, renomeações, compartilhamento, lixeira).
CREATE TABLE drive_activity (
  id             text PRIMARY KEY,
  folder_id      text REFERENCES drive_folders(id) ON DELETE CASCADE,
  file_id        text,
  actor_id       text,
  actor_username text,
  action         text NOT NULL,
  data           jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drive_activity_folder_idx ON drive_activity (folder_id, created_at DESC);

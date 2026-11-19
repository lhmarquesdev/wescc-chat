-- Arquivos: nomes de pastas e arquivos sem os caracteres invisíveis de direção do texto e de largura zero (ex.: U+202E,
-- que faz um ".exe" parecer ".pdf"). O app já limpa os nomes novos (cleanDriveName em shared/src/drive.ts, com a mesma
-- lista); aqui saem dos nomes já gravados. Se o nome limpo já existir na mesma pasta, ganha " (2)", " (3)"... como no
-- app. Pode rodar de novo sem mudar nada.
DO $$
DECLARE
  bad constant text := '[؜​‎‏‪-‮⁠⁦-⁩﻿]';
  r record;
  clean text;
  base text;
  ext text;
  cand text;
  dot int;
  n int;
BEGIN
  FOR r IN SELECT id, folder_id, name, trashed_at FROM drive_files WHERE name ~ bad ORDER BY created_at LOOP
    clean := btrim(regexp_replace(r.name, bad, '', 'g'));
    IF clean = '' OR clean ~ '^\.+$' THEN clean := 'arquivo'; END IF;
    dot := CASE WHEN strpos(reverse(clean), '.') > 0 THEN length(clean) - strpos(reverse(clean), '.') + 1 ELSE 0 END;
    base := CASE WHEN dot > 1 THEN left(clean, dot - 1) ELSE clean END;
    ext := CASE WHEN dot > 1 THEN substr(clean, dot) ELSE '' END;
    cand := clean;
    n := 1;
    WHILE r.trashed_at IS NULL AND EXISTS (
      SELECT 1 FROM drive_files WHERE folder_id = r.folder_id AND trashed_at IS NULL AND id <> r.id AND lower(name) = lower(cand)
    ) LOOP
      n := n + 1;
      cand := left(base, greatest(1, 200 - length(ext) - length(n::text) - 3)) || ' (' || n || ')' || ext;
    END LOOP;
    UPDATE drive_files SET name = cand WHERE id = r.id;
  END LOOP;

  FOR r IN SELECT id, parent_id, name, trashed_at FROM drive_folders WHERE name ~ bad ORDER BY created_at LOOP
    clean := btrim(regexp_replace(r.name, bad, '', 'g'));
    IF clean = '' OR clean ~ '^\.+$' THEN clean := 'pasta'; END IF;
    dot := CASE WHEN strpos(reverse(clean), '.') > 0 THEN length(clean) - strpos(reverse(clean), '.') + 1 ELSE 0 END;
    base := CASE WHEN dot > 1 THEN left(clean, dot - 1) ELSE clean END;
    ext := CASE WHEN dot > 1 THEN substr(clean, dot) ELSE '' END;
    cand := clean;
    n := 1;
    WHILE r.trashed_at IS NULL AND EXISTS (
      SELECT 1 FROM drive_folders
      WHERE coalesce(parent_id, '') = coalesce(r.parent_id, '') AND trashed_at IS NULL AND id <> r.id AND lower(name) = lower(cand)
    ) LOOP
      n := n + 1;
      cand := left(base, greatest(1, 120 - length(ext) - length(n::text) - 3)) || ' (' || n || ')' || ext;
    END LOOP;
    UPDATE drive_folders SET name = cand WHERE id = r.id;
  END LOOP;
END $$;

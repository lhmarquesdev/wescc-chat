import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS } from '../src/services/permissions';
import { PERMISSION_LABEL } from '../../web/src/pages/admin/permissionLabels';

// Toda permissão que o servidor cria (figurinhas, chamadas, Jira, Teams, papel Operação...) tem nome em português na
// matriz de Administração › Papéis e permissões; sem nome, ela aparece só com o id.
describe('nomes das permissões na administração', () => {
  it('cada permissão de DEFAULT_PERMISSIONS tem nome em português', () => {
    const missing = DEFAULT_PERMISSIONS.map(([id]) => id).filter((id) => !PERMISSION_LABEL[id]?.trim());
    expect(missing).toEqual([]);
  });

  it('as de figurinhas e de chamadas em grupo, em particular', () => {
    for (const id of ['create-personal-stickers', 'manage-sticker-packs', 'call-management', 'videoconf-ring-users', 'moderate-call', 'manage-calls', 'use-jira', 'create-jira-issue', 'manage-jira', 'start-msteams-meeting', 'manage-msteams']) {
      expect(PERMISSION_LABEL[id], id).toBeTruthy();
      expect(PERMISSION_LABEL[id], id).not.toBe(id);
    }
    // Nomes diferentes entre si: dois iguais na matriz confundem.
    const names = Object.values(PERMISSION_LABEL);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });
});

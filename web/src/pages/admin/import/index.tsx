import { Navigate, useParams } from 'react-router-dom';
import { usePermission } from '../../../lib/store';
import { Empty } from '../../../components/ui';
import { ImportHistory } from './ImportHistory';
import { ImportProgress } from './ImportProgress';
import { NewImport } from './NewImport';
import { PrepareImport } from './PrepareImport';

// /admin/import, /admin/import/new[/:importador], /admin/import/prepare e /admin/import/progress.
export function AdminImport() {
  const { view = '', param } = useParams();
  const canRun = usePermission('run-import');
  const canView = usePermission(['run-import', 'view-import-operations']);
  if (!canView) return <Empty>Você não tem permissão para ver as importações.</Empty>;
  if (!view) return <ImportHistory canRun={canRun} />;
  if (!canRun) return <Empty>Você não tem permissão para importar dados.</Empty>;
  if (view === 'new') return <NewImport importerKey={param} />;
  if (view === 'prepare') return <PrepareImport />;
  if (view === 'progress') return <ImportProgress />;
  return <Navigate to="/admin/import" replace />;
}

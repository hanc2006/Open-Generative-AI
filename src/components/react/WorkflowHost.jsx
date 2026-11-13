import { MemoryRouter } from '../../shims/next-navigation.jsx';
import WorkflowStudio from '../../../packages/studio/src/components/WorkflowStudio.jsx';
import { installAxiosSetup } from './axiosSetup.js';

installAxiosSetup();

export default function WorkflowHost(props) {
  return (
    <MemoryRouter initialPath="/studio/workflows">
      <WorkflowStudio {...props} />
    </MemoryRouter>
  );
}

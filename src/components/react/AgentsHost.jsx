import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { AiAgent, CreateAgentPage, EditAgentPage } from 'ai-agent';
import AgentStudio from '../../../packages/studio/src/components/AgentStudio.jsx';
import { getUserBalance } from '../../../packages/studio/src/muapi.js';
import { MemoryRouter, usePathname, useParams, useRouter } from '../../shims/next-navigation.jsx';
import { installAxiosSetup } from './axiosSetup.js';
import '../../../packages/Open-Poe-AI/packages/agents/src/tailwind.css';

installAxiosSetup();

function useStudioUser(apiKey) {
  const [userData, setUserData] = useState(null);
  useEffect(() => {
    if (!apiKey) return;
    getUserBalance(apiKey).then(setUserData).catch(() => setUserData(null));
  }, [apiKey]);

  return useCallback(() => ({
    user: {
      username: userData?.email?.split('@')[0] || 'Studio User',
      name: userData?.email?.split('@')[0] || 'Studio User',
      email: userData?.email || null,
      profile_photo: null,
      balance: userData?.balance || 0,
    },
    isAuthorized: !!userData,
  }), [userData]);
}

async function fetchJson(path) {
  try {
    const { data } = await axios.get(path);
    return data;
  } catch {
    return null;
  }
}

async function fetchAgent(agentId) {
  const bySlug = await fetchJson(`/api/agents/by-slug/${agentId}`);
  if (bySlug || agentId.length <= 20) return bySlug;
  return fetchJson(`/api/agents/${agentId}`);
}

async function fetchHistory(agentId, conversationId) {
  const bySlug = await fetchJson(`/api/agents/by-slug/${agentId}/${conversationId}`);
  if (bySlug || agentId.length <= 20) return bySlug;
  return fetchJson(`/api/agents/${agentId}/${conversationId}`);
}

function AgentChat({ useUser }) {
  const { agent_id, conversation_id } = useParams();
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    Promise.all([fetchAgent(agent_id), conversation_id ? fetchHistory(agent_id, conversation_id) : null])
      .then(([agentDetails, initialHistory]) => {
        if (!cancelled) setState({ loading: false, agentDetails, initialHistory });
      });
    return () => { cancelled = true; };
  }, [agent_id, conversation_id]);

  if (state.loading) return <div className="h-full flex items-center justify-center text-white/40 text-sm">Loading agent…</div>;
  return (
    <div className="h-full w-full bg-black overflow-hidden">
      <AiAgent
        key={`${agent_id}/${conversation_id || ''}`}
        initialAgentDetails={state.agentDetails}
        initialHistory={state.initialHistory}
        useUser={useUser}
        usedIn="muapiapp"
      />
    </div>
  );
}

function AgentsRoutes({ studioProps }) {
  const path = usePathname();
  const router = useRouter();
  const params = useParams();
  const useUser = useStudioUser(studioProps.apiKey);

  if (path === '/agents/create') {
    return <div className="h-full w-full bg-black overflow-y-auto"><CreateAgentPage useUser={useUser} /></div>;
  }
  if (path.startsWith('/agents/edit/')) {
    return <div className="h-full w-full bg-black overflow-y-auto"><EditAgentPage key={params.id} useUser={useUser} /></div>;
  }
  if (params.agent_id) return <AgentChat useUser={useUser} />;
  return <AgentStudio {...studioProps} />;
}

export default function AgentsHost(props) {
  return (
    <MemoryRouter initialPath="/agents">
      <AgentsRoutes studioProps={props} />
    </MemoryRouter>
  );
}

import './style.css';
import { Header } from './components/Header.js';
import { ImageStudio } from './components/ImageStudio.js';

const REACT_STUDIOS = {
  layers: () => import('../packages/studio/src/components/LayersStudio.jsx'),
  audio: () => import('../packages/studio/src/components/AudioStudio.jsx'),
  clipping: () => import('../packages/studio/src/components/ClippingStudio.jsx'),
  'motion-control': () => import('../packages/studio/src/components/MotionControlStudio.jsx'),
  'vibe-motion': () => import('../packages/studio/src/components/VibeMotionStudio.jsx'),
  'body-swap': () => import('../packages/studio/src/components/RecastStudio.jsx'),
  marketing: () => import('../packages/studio/src/components/MarketingStudio.jsx'),
  workflows: () => import('./components/react/WorkflowHost.jsx'),
  agents: () => import('./components/react/AgentsHost.jsx'),
  local: () => import('./components/LocalInferenceStudio.jsx'),
};

const app = document.querySelector('#app');
let contentArea;

// Keep all mounted page nodes so async generation survives tab switches
const mountedPages = {};

// Router — show/hide instead of destroy
function navigate(page) {
  if (!contentArea) return;

  // Hide all existing pages
  Object.values(mountedPages).forEach(node => { node.style.display = 'none'; });

  if (mountedPages[page]) {
    // Already mounted — just show it again
    mountedPages[page].style.display = '';
  } else {
    // First visit — create a wrapper and mount the studio into it
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;';
    contentArea.appendChild(wrapper);
    mountedPages[page] = wrapper;

    if (page === 'image') {
      wrapper.appendChild(ImageStudio());
    } else if (page === 'video') {
      import('./components/VideoStudio.js').then(({ VideoStudio }) => {
        wrapper.appendChild(VideoStudio());
      });
    } else if (page === 'cinema') {
      import('./components/CinemaStudio.js').then(({ CinemaStudio }) => {
        wrapper.appendChild(CinemaStudio());
      });
    } else if (page === 'lipsync') {
      import('./components/LipSyncStudio.js').then(({ LipSyncStudio }) => {
        wrapper.appendChild(LipSyncStudio());
      });
    } else if (REACT_STUDIOS[page]) {
      import('./components/ReactStudio.js').then(({ ReactStudio }) => {
        wrapper.appendChild(ReactStudio(REACT_STUDIOS[page]));
      });
    }
  }
}

app.innerHTML = '';
// Pass navigate to Header so links work
app.appendChild(Header(navigate));

contentArea = document.createElement('main');
contentArea.id = 'content-area';
contentArea.className = 'flex-1 relative w-full overflow-hidden flex flex-col bg-app-bg';
app.appendChild(contentArea);

// Initial Route
navigate('image');

// Event Listener for Navigation
window.addEventListener('navigate', (e) => {
  if (e.detail.page === 'settings') {
    import('./components/SettingsModal.js').then(({ SettingsModal }) => {
      document.body.appendChild(SettingsModal());
    });
  } else {
    navigate(e.detail.page);
  }
});

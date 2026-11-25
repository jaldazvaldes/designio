import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from './Editor';
import { Home } from './Home';
import { RenderPage } from './render/RenderPage';
import './styles.css';
import './presence.css';

function App() {
  if (location.pathname === '/render') return <RenderPage />;
  const doc = new URLSearchParams(location.search).get('doc');
  return doc ? <Editor docId={doc} /> : <Home />;
}

const isRender = location.pathname === '/render';
document.documentElement.classList.toggle('is-render', isRender);

createRoot(document.getElementById('root')!).render(
  isRender ? (
    <App />
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  ),
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { migrateLegacyHash } from './ui/site/router';

// An old `#/guide`-style link lands on its real path before anything renders.
migrateLegacyHash();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

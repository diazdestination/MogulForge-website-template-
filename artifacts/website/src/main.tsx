import { createRoot, hydrateRoot } from 'react-dom/client';

import App from './App';

import './index.css';

const container = document.getElementById('root')!;

// Prerendered pages ship full HTML — hydrate; dev server ships an empty shell — render.
if (container.hasChildNodes()) {
  hydrateRoot(container, <App />);
} else {
  createRoot(container).render(<App />);
}

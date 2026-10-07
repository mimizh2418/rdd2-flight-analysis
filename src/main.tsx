import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

// StrictMode exercises effect cleanup during development, including chart and WebGL resource disposal.
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

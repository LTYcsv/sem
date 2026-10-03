import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/pt-sans/400.css';
import '@fontsource/pt-sans/700.css';
import './styles.css';
import { TeamApp } from './team/TeamApp';
import { AdminApp } from './admin/AdminApp';

const isAdmin = location.pathname.startsWith('/admin');
createRoot(document.getElementById('root')!).render(<StrictMode>{isAdmin ? <AdminApp /> : <TeamApp />}</StrictMode>);

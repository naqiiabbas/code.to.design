import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const mount = document.createElement('div');
document.body.appendChild(mount);
createRoot(mount).render(<App />);

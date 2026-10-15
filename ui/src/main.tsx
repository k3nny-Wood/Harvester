import ReactDOM from 'react-dom/client';
import './styles.css';
import { wantsMobile } from './mobile/store';

// the phone layout on a narrow screen, the docked desktop layout otherwise (each is loaded only when it is used)
async function start() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);
  if (wantsMobile()) {
    const { MobileApp } = await import('./mobile/MobileApp');
    root.render(<MobileApp />);
  } else {
    await import('dockview-react/dist/styles/dockview.css');
    const { App } = await import('./App');
    root.render(<App />);
  }
}

void start();

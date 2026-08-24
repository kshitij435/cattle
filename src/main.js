// =========================================================================
// ENTRY POINT -- imports the core app (which runs its own initialization
// at the bottom, same as the original's inline script) and separately
// initializes the independent Case Details panel.
// =========================================================================
import './app.js';
import { initCaseDetailsPanel } from './capture/case-details.js';

initCaseDetailsPanel();

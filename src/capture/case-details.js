// =========================================================================
// CASE DETAILS PANEL -- a separate farmer/case metadata form (loan
// proposal, farmer name, village, animal details, etc.), saved to
// localStorage so it survives a page reload. Genuinely independent of the
// photo-capture core (doesn't touch `state`, `captures`, or the camera at
// all), so this was safe to extract into its own module as-is.
// Extracted verbatim from the original index.html.
// =========================================================================

const CD_FIELD_IDS = [
  'cd_loanProposal','cd_farmerName','cd_village','cd_taluka','cd_district','cd_occupation',
  'cd_insurerOrg','cd_remarks','cd_surveyDate','cd_address','cd_subCaseStatus',
  'cd_animalType','cd_age','cd_gender','cd_breed','cd_tagNo','cd_marketValue','cd_color',
  'cd_swishOfTail','cd_rightHorn','cd_leftHorn','cd_lactation','cd_dailyMilk',
  'cd_distinguishingFeature','cd_sumInsured','cd_policyDuration','cd_premiumAmt'
];
const CD_STORAGE_KEY = 'cattleClaimCaseDetails';

function cdGetAll(){
  const out = {};
  CD_FIELD_IDS.forEach(id => { out[id] = document.getElementById(id).value.trim(); });
  return out;
}
function cdIsFilled(){
  const v = cdGetAll();
  return !!(v.cd_farmerName && v.cd_tagNo);
}
function cdUpdateDot(){
  document.getElementById('caseDetailsBtnDot').classList.toggle('filled', cdIsFilled());
}
function cdLoad(){
  try{
    const saved = JSON.parse(localStorage.getItem(CD_STORAGE_KEY) || '{}');
    CD_FIELD_IDS.forEach(id => { if(saved[id] !== undefined) document.getElementById(id).value = saved[id]; });
  }catch(e){ console.warn('Could not load saved case details:', e); }
  cdUpdateDot();
}
function cdSave(){
  const data = cdGetAll();
  localStorage.setItem(CD_STORAGE_KEY, JSON.stringify(data));
  cdUpdateDot();
  const status = document.getElementById('cdStatus');
  status.textContent = 'Saved.';
  setTimeout(() => { status.textContent = ''; }, 2000);
}
window.getCaseDetails = cdGetAll;

export function initCaseDetailsPanel(){
  document.getElementById('caseDetailsBtn').addEventListener('click', () => {
    document.getElementById('caseDetailsPanel').classList.add('show');
  });
  document.getElementById('cdCloseBtn').addEventListener('click', () => {
    document.getElementById('caseDetailsPanel').classList.remove('show');
  });
  document.getElementById('cdSaveBtn').addEventListener('click', cdSave);

  cdLoad();
}

const form = document.querySelector('#collector-form');
const statusBox = document.querySelector('#status');
const resultBox = document.querySelector('#result');
const submitButton = document.querySelector('#submit-button');
const pageTitle = document.querySelector('#page-title');
const introCopy = document.querySelector('#intro-copy');
const modeHelp = document.querySelector('#mode-help');
const modeInputs = Array.from(document.querySelectorAll('input[name="mode"]'));
const urlInputs = Array.from(document.querySelectorAll('input[name^="url"]'));
const logoOnlyFields = Array.from(document.querySelectorAll('[data-logo-only="true"]'));

const MODE_COPY = {
  images: {
    title: 'Collect up to 75 images from six exact pages.',
    intro:
      'Paste one to six URLs from any sites. The app checks only those pages, uses a browser fallback for Google and GBP-style links when needed, saves the first valid images it finds, and writes them into a timestamped folder on your computer.',
    help: 'Image mode accepts up to 6 URLs and downloads up to 75 images across them.',
    button: 'Download Images',
    status: 'Downloading images from the provided pages. This can take a moment.'
  },
  logos: {
    title: 'Extract clean square logo PNGs from client sites.',
    intro:
      'Paste one to eight client website URLs. Logo PNG mode looks for each site logo, removes the background when needed, pads it to a 1:1 transparent PNG, and saves the result into a timestamped export folder on your computer.',
    help: 'Logo PNG mode accepts up to 8 URLs, works best with homepages, and may take longer on the first run.',
    button: 'Extract Logos',
    status: 'Finding logos, removing backgrounds, and exporting square PNG files. This can take a bit longer.'
  }
};

for (const input of modeInputs) {
  input.addEventListener('change', syncModeUi);
}

syncModeUi();

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const mode = String(formData.get('mode') ?? 'images');
  const urls = urlInputs
    .map((input) => (input.disabled ? '' : String(formData.get(input.name) ?? '').trim()))
    .filter(Boolean);

  if (urls.length === 0) {
    renderStatus('Enter at least one URL before starting.', true);
    renderResult();
    return;
  }

  renderStatus(MODE_COPY[mode]?.status ?? MODE_COPY.images.status, false);
  renderResult();
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ urls, mode })
    });

    const payload = await response.json();

    if (!response.ok) {
      const details = payload.details ? renderSummary(payload.details) : '';
      renderStatus(payload.error || 'The download failed.', true);
      renderResult(details, true);
      return;
    }

    renderStatus('Download complete.', false);
    renderResult(renderSummary(payload), false);
  } catch (error) {
    renderStatus(error.message || 'The download failed.', true);
    renderResult();
  } finally {
    submitButton.disabled = false;
  }
});

function renderStatus(message = '', isError = false) {
  statusBox.textContent = message;
  statusBox.classList.toggle('error', isError);
}

function renderResult(content = '', isError = false) {
  resultBox.innerHTML = content;
  resultBox.classList.toggle('error', isError);
}

function renderSummary(result) {
  const mode = result.mode === 'logos' ? 'logos' : 'images';
  const primaryCountLabel = mode === 'logos' ? 'Logos saved' : 'Images saved';
  const primaryCountValue = mode === 'logos' ? String(result.logosSaved ?? 0) : String(result.imagesSaved ?? 0);
  const errorItems = Array.isArray(result.errors)
    ? result.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')
    : '';
  const itemList = Array.isArray(result.items) && result.items.length > 0
    ? result.items
        .map((item) => `<li>${escapeHtml(item.fileName)} from ${escapeHtml(item.sourceUrl ?? item.inputUrl ?? '')}</li>`)
        .join('')
    : '';

  return `
    <h2>Run Summary</h2>
    <dl>
      <dt>Source sites</dt>
      <dd>${escapeHtml(Array.isArray(result.sourceDomains) && result.sourceDomains.length > 0 ? result.sourceDomains.join(', ') : (result.domain ?? 'Unknown'))}</dd>
      <dt>Pages checked</dt>
      <dd>${escapeHtml(String(result.pagesScanned ?? 0))}</dd>
      <dt>${escapeHtml(primaryCountLabel)}</dt>
      <dd>${escapeHtml(primaryCountValue)}</dd>
      <dt>Skipped duplicates</dt>
      <dd>${escapeHtml(String(result.skippedDuplicates ?? 0))}</dd>
      <dt>Skipped invalid</dt>
      <dd>${escapeHtml(String(result.skippedInvalid ?? 0))}</dd>
      <dt>Saved folder</dt>
      <dd>${escapeHtml(result.outputPath ?? 'Not created')}</dd>
    </dl>
    ${itemList ? `<ul>${itemList}</ul>` : ''}
    ${errorItems ? `<ul>${errorItems}</ul>` : ''}
  `;
}

function syncModeUi() {
  const selectedMode = modeInputs.find((input) => input.checked)?.value ?? 'images';
  const copy = MODE_COPY[selectedMode] ?? MODE_COPY.images;
  const logoMode = selectedMode === 'logos';

  pageTitle.textContent = copy.title;
  introCopy.textContent = copy.intro;
  modeHelp.textContent = copy.help;
  submitButton.textContent = copy.button;

  for (const field of logoOnlyFields) {
    field.hidden = !logoMode;

    const input = field.querySelector('input');
    if (input) {
      input.disabled = !logoMode;
    }
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

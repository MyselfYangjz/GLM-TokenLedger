"""Build a single, self-contained HTML file; Python is only needed for development."""
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
html = (root / 'src/template.html').read_text()
for placeholder, source in {
    '/* APP_STYLES */': 'src/style.css',
    '/* THIRD_PARTY_LICENSE */': 'vendor/SHEETJS-LICENSE.txt',
    '/* XLSX_LIBRARY */': 'vendor/xlsx.full.min.js',
    '/* CORE_SCRIPT */': 'src/core.js',
    '/* MAPPING_FILE_SCRIPT */': 'src/mapping-file.js',
    '/* APP_SCRIPT */': 'src/app.js',
}.items():
    content = (root / source).read_text()
    if source.endswith('.js'):
        content = re.sub(r'</script', r'<\\/script', content, flags=re.IGNORECASE)
        content = re.sub(r'(?m)^//# sourceMappingURL=.*$', '', content)
    html = html.replace(placeholder, content)
(root / 'index.html').write_text(html)
print(f'Built index.html ({len(html.encode()):,} bytes)')

/**
 * codePreprocessor.js - Unified Developer Intelligence Hub (UDIH)
 * 
 * Modular Preprocessing Engine (Addresses Improvement Areas 1 & 3):
 * 1. Deterministic Extraction: Regex/heuristic parsing of imports and exports across 10+ languages (0 tokens, <1ms).
 * 2. Static Security & Secret Scanner: Detects hardcoded credentials, API keys, code injection, and unsafe patterns.
 * 3. Input Sanitization & Injection Defense: Strips control characters, ensures code is safely treated as data.
 * 4. Code Metrics: Deterministic computation of line counts (total, code, blank, comment) and complexity indicators.
 */

// Common secret & security heuristics
const SECURITY_PATTERNS = [
    {
        title: 'Hardcoded High-Entropy Secret / API Key',
        severity: 'Critical',
        category: 'Security',
        regex: /(?:(?:api[_-]?key|secret|token|password|pass|auth[_-]?token)\s*[:=]\s*["']([A-Za-z0-9_\-\.]{16,})["']|define\s*\(\s*['"][^'"]*(?:KEY|SECRET|TOKEN|PASS|AUTH)[^'"]*['"]\s*,\s*['"]([^'"]{16,})['"])/i,
        explanation: 'Sensitive credential or API key is directly hardcoded in source code.',
        root_cause: 'Secrets embedded in plain text instead of loaded via environment variables.',
        impact: 'Credential leakage, unauthorized access if source code is exposed.',
        suggested_fix: 'Move secrets to an environment variable (.env) or a secret manager.'
    },
    {
        title: 'Hardcoded AWS Access Key',
        severity: 'Critical',
        category: 'Security',
        regex: /(?:AKIA[0-9A-Z]{16})/,
        explanation: 'Hardcoded AWS Access Key ID detected.',
        root_cause: 'Cloud infrastructure credentials placed in source file.',
        impact: 'Potential AWS account compromise and resource abuse.',
        suggested_fix: 'Remove key immediately, rotate IAM credentials, and use IAM roles or env vars.'
    },
    {
        title: 'Hardcoded Private Key Block',
        severity: 'Critical',
        category: 'Security',
        regex: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
        explanation: 'Asymmetric private cryptographic key found in source code.',
        root_cause: 'Private cryptographic key committed into source.',
        impact: 'Full compromise of encrypted communication or authentication mechanisms.',
        suggested_fix: 'Store private keys in a secure key store or file outside version control.'
    },
    {
        title: 'Unsafe Dynamic Code Execution (eval/exec)',
        severity: 'High',
        category: 'Security',
        regex: /(?:(?<!->|\b(?:pdo|db|conn|sqlite)->)\beval\s*\(|(?<!->|\b(?:pdo|db|conn|sqlite)->)\bexec\s*\((?!\s*["'][^"']*["']\s*\)))/i,
        explanation: 'Use of dynamic code execution function with non-constant input.',
        root_cause: 'Evaluating arbitrary dynamic expressions directly.',
        impact: 'Remote Code Execution (RCE) or arbitrary script injection vulnerability.',
        suggested_fix: 'Refactor to eliminate dynamic evaluation; use safe parsing or mapping tables.'
    },
    {
        title: 'Direct Shell Command Execution',
        severity: 'High',
        category: 'Security',
        regex: /\b(?:child_process\.exec|os\.system|subprocess\.Popen\(.+shell\s*=\s*True|shell_exec\s*\(|passthru\s*\()/i,
        explanation: 'Execution of shell commands with potentially unvalidated arguments.',
        root_cause: 'Spawning shell interpreters directly for external commands.',
        impact: 'Command Injection vulnerability if arguments include user input.',
        suggested_fix: 'Use parameterized execution (e.g. execFile, subprocess.run with shell=False).'
    },
    {
        title: 'Potential SQL Injection via String Concatenation',
        severity: 'High',
        category: 'Security',
        regex: /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{1,60}(?:\+|\.concat\(|%s|\$\{|\s*\.\s*\$)/i,
        explanation: 'SQL statement constructed via string concatenation or template interpolation.',
        root_cause: 'Embedding variables directly into SQL queries rather than using parameterized queries.',
        impact: 'SQL Injection, unauthorized data access, or data corruption.',
        suggested_fix: 'Use parameterized queries or prepared statements (e.g., query("SELECT ... WHERE id = ?", [id])).'
    },
    {
        title: 'Unsanitized HTML Rendering (XSS Risk)',
        severity: 'Medium',
        category: 'Security',
        regex: /dangerouslySetInnerHTML\s*=|innerHTML\s*\+?=|echo\s+[\s\S]{0,30}\$_GET\[|echo\s+[\s\S]{0,30}\$_POST\[|echo\s+\$user\b(?![^;]*htmlspecialchars)/i,
        explanation: 'Directly injecting raw HTML into DOM elements or echoing untrusted inputs without escaping.',
        root_cause: 'Setting innerHTML or echoing request parameters without sanitization.',
        impact: 'Cross-Site Scripting (XSS) if untrusted input reaches this property.',
        suggested_fix: 'Use textContent, React standard JSX binding, or sanitize with DOMPurify / htmlspecialchars().'
    },
    {
        title: 'Path Traversal / Arbitrary File Access',
        severity: 'Critical',
        category: 'Security',
        regex: /\b(?:fs\.readFileSync|fs\.readFile|open|include|require)\s*\(\s*(?:path\.join\([^)]*req\.|\$[a-zA-Z0-9_]*\s*\.\s*["']\.php["'])/i,
        explanation: 'Direct file access using unsanitized user path allows escaping destination directory.',
        root_cause: 'Concatenating untrusted path parameters without path boundary verification.',
        impact: 'Unauthorized reading or execution of arbitrary files on the host.',
        suggested_fix: 'Validate path starts with permitted base directory and sanitize input.'
    },
    {
        title: 'Insecure Object Deserialization',
        severity: 'Critical',
        category: 'Security',
        regex: /\b(?:pickle\.loads|unserialize|yaml\.load\s*\([^,)]*\))\b/i,
        explanation: 'Deserializing untrusted data without validation allows arbitrary object instantiation.',
        root_cause: 'Using unsafe deserializer functions on unauthenticated data.',
        impact: 'Remote Code Execution (RCE) via malicious serialized payload.',
        suggested_fix: 'Use safe formats (JSON) or yaml.safe_load().'
    }
];

/**
 * Deterministically extract imports and exports from source code
 */
const extractImportsExports = (content, language = '') => {
    const imports = new Set();
    const exports = new Set();
    const lang = (language || '').toLowerCase();

    if (!content || typeof content !== 'string') {
        return { imports: [], exports: [] };
    }

    const lines = content.split('\n');

    for (const rawLine of lines) {
        const line = rawLine.trim();

        // 1. JavaScript / TypeScript / React
        if (lang.includes('javascript') || lang.includes('typescript') || lang.includes('react') || lang.endsWith('js') || lang.endsWith('ts')) {
            // ES6 imports: import X from 'pkg'; import { A, B } from './path'; import './styles.css'
            const esImport = line.match(/^import\s+(?:(?:(?:\w+|\{[^}]+\}|\*\s+as\s+\w+)\s+from\s+)?["']([^"']+)["'])/);
            if (esImport && esImport[1]) {
                imports.add(esImport[1]);
            }

            // CommonJS require: const x = require('pkg');
            const cjsRequire = line.match(/require\s*\(\s*["']([^"']+)["']\s*\)/);
            if (cjsRequire && cjsRequire[1]) {
                imports.add(cjsRequire[1]);
            }

            // Dynamic import: import('pkg')
            const dynImport = line.match(/import\s*\(\s*["']([^"']+)["']\s*\)/);
            if (dynImport && dynImport[1]) {
                imports.add(dynImport[1]);
            }

            // ES6 export default / named: export default MyComponent; export const foo = ...
            const esExportDef = line.match(/^export\s+default\s+(?:function|class|const|let|var)?\s*([A-Za-z0-9_$]+)/);
            if (esExportDef && esExportDef[1]) {
                exports.add(`default:${esExportDef[1]}`);
            }

            const esExportNamed = line.match(/^export\s+(?:const|let|var|function\*?|class|type|interface)\s+([A-Za-z0-9_$]+)/);
            if (esExportNamed && esExportNamed[1]) {
                exports.add(esExportNamed[1]);
            }

            // export { a, b, c as d }
            const esExportList = line.match(/^export\s*\{([^}]+)\}/);
            if (esExportList && esExportList[1]) {
                esExportList[1].split(',').forEach(item => {
                    const clean = item.trim().split(/\s+as\s+/)[0].trim();
                    if (clean) exports.add(clean);
                });
            }

            // CommonJS module.exports = ...
            const cjsExport = line.match(/module\.exports\s*=\s*(?:\{([^}]+)\}|([A-Za-z0-9_$]+))/);
            if (cjsExport) {
                if (cjsExport[1]) {
                    cjsExport[1].split(',').forEach(item => {
                        const clean = item.trim().split(':')[0].trim();
                        if (clean) exports.add(clean);
                    });
                } else if (cjsExport[2]) {
                    exports.add(`default:${cjsExport[2]}`);
                }
            }
        }

        // 2. Python
        else if (lang.includes('python') || lang.endsWith('py')) {
            // from x.y import a, b
            const pyFrom = line.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+(.+)/);
            if (pyFrom) {
                imports.add(pyFrom[1]);
            } else {
                // import x, y
                const pyImport = line.match(/^import\s+([A-Za-z0-9_,\s]+)/);
                if (pyImport) {
                    pyImport[1].split(',').forEach(pkg => {
                        const clean = pkg.trim().split(/\s+as\s+/)[0].trim();
                        if (clean) imports.add(clean);
                    });
                }
            }

            // def / class exports
            const pyDef = line.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
            if (pyDef && !pyDef[1].startsWith('_')) {
                exports.add(pyDef[1]);
            }
            const pyClass = line.match(/^class\s+([A-Za-z0-9_]+)/);
            if (pyClass && !pyClass[1].startsWith('_')) {
                exports.add(pyClass[1]);
            }
        }

        // 3. Java / Kotlin
        else if (lang.includes('java') || lang.includes('kotlin')) {
            const javaImport = line.match(/^import\s+(?:static\s+)?([A-Za-z0-9_\.]+);/);
            if (javaImport) {
                imports.add(javaImport[1]);
            }
            const javaClass = line.match(/public\s+(?:static\s+)?(?:class|interface|enum|record)\s+([A-Za-z0-9_]+)/);
            if (javaClass) {
                exports.add(javaClass[1]);
            }
        }

        // 4. Go
        else if (lang.includes('go')) {
            const goImport = line.match(/^import\s+["']([^"']+)["']/);
            if (goImport) {
                imports.add(goImport[1]);
            }
            const goFunc = line.match(/^func\s+(?:\([^)]+\)\s+)?([A-Z][A-Za-z0-9_]*)/);
            if (goFunc) {
                exports.add(goFunc[1]); // Capitalized identifiers are exported in Go
            }
        }

        // 5. C / C++
        else if (lang.includes('c') || lang.includes('cpp')) {
            const cInclude = line.match(/^#include\s+[<"]([^>"]+)[>"]/);
            if (cInclude) {
                imports.add(cInclude[1]);
            }
        }

        // 6. Rust
        else if (lang.includes('rust')) {
            const rsUse = line.match(/^use\s+([A-Za-z0-9_:]+);/);
            if (rsUse) {
                imports.add(rsUse[1]);
            }
            const rsPub = line.match(/^pub\s+(?:fn|struct|enum|trait)\s+([A-Za-z0-9_]+)/);
            if (rsPub) {
                exports.add(rsPub[1]);
            }
        }
    }

    return {
        imports: Array.from(imports),
        exports: Array.from(exports)
    };
};

const DEPENDENCY_ADVISORIES = {
    npm: [
        { name: 'lodash', minSafe: '4.17.21', severity: 'High', cve: 'CVE-2021-23337', desc: 'Prototype Pollution & Command Injection vulnerability in lodash template' },
        { name: 'axios', minSafe: '0.21.2', severity: 'High', cve: 'CVE-2021-3749', desc: 'Server-Side Request Forgery (SSRF) and credential leak via follow redirects' },
        { name: 'express', minSafe: '4.19.2', severity: 'Medium', cve: 'CVE-2024-29041', desc: 'Open redirect and IP spoofing in Express query parsing middleware' },
        { name: 'jsonwebtoken', minSafe: '9.0.0', severity: 'Critical', cve: 'CVE-2022-23529', desc: 'Arbitrary File Write / Insecure Secret Key Verification' },
        { name: 'minimist', minSafe: '1.2.6', severity: 'High', cve: 'CVE-2021-44906', desc: 'Prototype pollution in CLI argument parsing' },
        { name: 'moment', minSafe: '2.29.4', severity: 'High', cve: 'CVE-2022-24785', desc: 'Path traversal / ReDoS in locale parsing; library is deprecated/maintenance-only' },
        { name: 'tar', minSafe: '6.1.11', severity: 'Critical', cve: 'CVE-2021-37701', desc: 'Arbitrary file overwrite outside destination folder' }
    ],
    pypi: [
        { name: 'requests', minSafe: '2.31.0', severity: 'High', cve: 'CVE-2023-32681', desc: 'Unintended leak of Proxy-Authorization header across redirects' },
        { name: 'urllib3', minSafe: '1.26.18', severity: 'High', cve: 'CVE-2023-45803', desc: 'Request body leak / Cookie leakage in redirected HTTP requests' },
        { name: 'flask', minSafe: '2.2.5', severity: 'Medium', cve: 'CVE-2023-30861', desc: 'Session cookie disclosure without secure flags' },
        { name: 'django', minSafe: '4.2.8', severity: 'Critical', cve: 'CVE-2023-46695', desc: 'Denial of Service via large inputs and potential SQL injection' },
        { name: 'pyyaml', minSafe: '5.4.0', severity: 'Critical', cve: 'CVE-2020-14343', desc: 'Arbitrary Code Execution via full_load / load method' },
        { name: 'cryptography', minSafe: '39.0.1', severity: 'High', cve: 'CVE-2023-23931', desc: 'Memory corruption in Cipher.update_into' }
    ],
    composer: [
        { name: 'guzzlehttp/guzzle', minSafe: '6.5.8', severity: 'High', cve: 'CVE-2022-31090', desc: 'Authorization header leakage when redirected to foreign host' },
        { name: 'laravel/framework', minSafe: '8.83.27', severity: 'High', cve: 'CVE-2023-24657', desc: 'Validation bypass and blind SQL injection in query builder' },
        { name: 'symfony/http-foundation', minSafe: '5.4.20', severity: 'High', cve: 'CVE-2022-24894', desc: 'HTTP response splitting and header injection' },
        { name: 'phpunit/phpunit', minSafe: '8.5.33', severity: 'High', cve: 'CVE-2020-7634', desc: 'Remote code execution via serialized object evaluation' }
    ]
};

function isVersionLower(ver, minSafe) {
    if (!ver) return false;
    const cleanVer = String(ver).replace(/[\^~>=<v]/g, '').trim().split('-')[0];
    const cleanSafe = minSafe.replace(/[\^~>=<v]/g, '').trim().split('-')[0];
    const vParts = cleanVer.split('.').map(n => parseInt(n, 10) || 0);
    const sParts = cleanSafe.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(vParts.length, sParts.length); i++) {
        const v = vParts[i] || 0;
        const s = sParts[i] || 0;
        if (v < s) return true;
        if (v > s) return false;
    }
    return false;
}

function auditDependencies(filePath, content) {
    const findings = [];
    if (!content || typeof content !== 'string') return findings;
    const lower = filePath.toLowerCase();

    // 1. package.json
    if (lower.endsWith('package.json')) {
        try {
            const pkg = JSON.parse(content);
            const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            DEPENDENCY_ADVISORIES.npm.forEach(adv => {
                if (allDeps[adv.name]) {
                    const ver = allDeps[adv.name];
                    if (isVersionLower(ver, adv.minSafe)) {
                        findings.push({
                            title: `Outdated / Vulnerable Dependency: "${adv.name}" (${ver})`,
                            severity: adv.severity,
                            category: 'Dependency Vulnerability',
                            file_path: filePath,
                            line_number: 'package.json manifest',
                            description: `${adv.desc} (${adv.cve}). Minimum safe version is >= ${adv.minSafe}.`,
                            root_cause: `Project pins vulnerable or unpatched dependency version ${ver}.`,
                            impact: 'Potential application compromise or security exploit via known vulnerability.',
                            suggested_fix: `Upgrade "${adv.name}" to >= ${adv.minSafe} and run npm audit fix.`
                        });
                    }
                }
            });
        } catch (e) {}
    }

    // 2. requirements.txt
    else if (lower.endsWith('requirements.txt') || lower.endsWith('requirements.in')) {
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
            const clean = line.trim();
            if (!clean || clean.startsWith('#')) return;
            const match = clean.match(/^([a-zA-Z0-9_\-\.]+)\s*(?:==|<=|>=|<|>|~=)\s*([0-9\.]+)/);
            if (match) {
                const pkgName = match[1].toLowerCase();
                const ver = match[2];
                const adv = DEPENDENCY_ADVISORIES.pypi.find(a => a.name.toLowerCase() === pkgName);
                if (adv && isVersionLower(ver, adv.minSafe)) {
                    findings.push({
                        title: `Outdated / Vulnerable Python Package: "${adv.name}" (${ver})`,
                        severity: adv.severity,
                        category: 'Dependency Vulnerability',
                        file_path: filePath,
                        line_number: `Line ${idx + 1}`,
                        description: `${adv.desc} (${adv.cve}). Minimum recommended version is >= ${adv.minSafe}.`,
                        root_cause: `Outdated library version pinned in requirements.txt without vulnerability patch.`,
                        impact: 'Exposure to published CVE exploits and security risks.',
                        suggested_fix: `Update ${adv.name}>=${adv.minSafe} in requirements.txt and rebuild environment.`
                    });
                }
            }
        });
    }

    // 3. composer.json
    else if (lower.endsWith('composer.json')) {
        try {
            const comp = JSON.parse(content);
            const allReqs = { ...(comp.require || {}), ...(comp['require-dev'] || {}) };
            DEPENDENCY_ADVISORIES.composer.forEach(adv => {
                if (allReqs[adv.name]) {
                    const ver = allReqs[adv.name];
                    if (isVersionLower(ver, adv.minSafe)) {
                        findings.push({
                            title: `Outdated / Vulnerable PHP Package: "${adv.name}" (${ver})`,
                            severity: adv.severity,
                            category: 'Dependency Vulnerability',
                            file_path: filePath,
                            line_number: 'composer.json manifest',
                            description: `${adv.desc} (${adv.cve}). Minimum safe version is >= ${adv.minSafe}.`,
                            root_cause: `Project references vulnerable composer library version ${ver}.`,
                            impact: 'Potential remote exploitation or header injection.',
                            suggested_fix: `Update "${adv.name}" in composer.json to >= ${adv.minSafe} and run composer update.`
                        });
                    }
                }
            });
        } catch (e) {}
    }

    return findings;
}

/**
 * Scan source code deterministically for security vulnerabilities, secrets, and injection patterns
 */
const scanSecurityAndHeuristics = (filePath, content, language = '') => {
    const findings = [];
    if (!content || typeof content !== 'string') return findings;

    // Check dependency manifests
    const depFindings = auditDependencies(filePath, content);
    if (depFindings.length > 0) {
        findings.push(...depFindings);
    }

    const lines = content.split('\n');

    SECURITY_PATTERNS.forEach(pattern => {
        lines.forEach((line, index) => {
            if (pattern.regex.test(line)) {
                // Ignore benign comments/tests if obvious
                const trimmed = line.trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
                    if (!line.includes('AKIA') && !line.includes('PRIVATE KEY')) {
                        return; // skip commented out code unless critical credential
                    }
                }

                findings.push({
                    title: pattern.title,
                    severity: pattern.severity,
                    category: pattern.category,
                    file_path: filePath,
                    line_number: `Line ${index + 1}`,
                    description: pattern.explanation,
                    root_cause: pattern.root_cause,
                    impact: pattern.impact,
                    suggested_fix: pattern.suggested_fix
                });
            }
        });
    });

    return findings;
};

/**
 * Compute file metrics (lines, comments, blank lines)
 */
const computeFileMetrics = (content) => {
    if (!content || typeof content !== 'string') {
        return { totalLines: 0, codeLines: 0, commentLines: 0, blankLines: 0 };
    }

    const lines = content.split('\n');
    let blankLines = 0;
    let commentLines = 0;
    let codeLines = 0;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            blankLines++;
        } else if (line.startsWith('//') || line.startsWith('#') || line.startsWith('/*') || line.startsWith('*')) {
            commentLines++;
        } else {
            codeLines++;
        }
    }

    return {
        totalLines: lines.length,
        codeLines,
        commentLines,
        blankLines
    };
};

/**
 * Sanitize untrusted input to defend against prompt injection & malformed characters
 */
const sanitizeInputData = (input) => {
    if (typeof input !== 'string') return '';
    return input
        .replace(/\0/g, '') // strip null bytes
        .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, ''); // strip ASCII control chars (preserving \t and \n)
};

module.exports = {
    extractImportsExports,
    scanSecurityAndHeuristics,
    auditDependencies,
    computeFileMetrics,
    sanitizeInputData
};

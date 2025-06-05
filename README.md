GitHub Service Dependency Analyzer
A powerful TypeScript tool that analyzes your GitHub organization's repositories to build comprehensive service dependency graphs. Perfect for understanding service relationships, impact analysis, and architectural insights across large codebases.
🎯 What It Does

Discovers Service Dependencies: Scans 900+ repositories to find who depends on what
Multi-Format Support: Analyzes Docker Compose, Kubernetes YAML, package.json, Cargo.toml, and more
Impact Analysis: Identifies high-impact services that affect many consumers
Confidence Scoring: Rates dependency detection accuracy (high/medium/low confidence)
Comprehensive Reporting: Generates both human-readable reports and machine-readable JSON

🚀 Quick Start
Prerequisites

Node.js 16+
GitHub Personal Access Token with repo access
TypeScript (optional, can use ts-node)

Installation
bash# Clone or download the analyzer
git clone <your-repo>
cd github-service-analyzer

# Install dependencies
npm install @octokit/rest js-yaml
npm install -D @types/js-yaml typescript ts-node
Configuration
Set up your environment variables:
bash# Required: GitHub Personal Access Token
export GITHUB_TOKEN="ghp_your_token_here"

# Required: Your GitHub organization name
export GITHUB_ORG="your-company"
Running the Analysis
bash# Run the analyzer
npx ts-node dependency-analyzer.ts

# Or compile and run
npx tsc dependency-analyzer.ts
node dependency-analyzer.js
📊 Output Files
The analyzer generates two key files:
dependency-report.md
Human-readable markdown report containing:

Organization overview and statistics
High-impact services ranked by consumer count
Detailed dependency listings
Impact analysis for change planning

dependency-graph.json
Machine-readable JSON containing:

Complete dependency graph data
Service nodes with producers and consumers
Detailed dependency metadata
Confidence scores and source file references

🔧 Supported File Types
The analyzer automatically detects and parses:
File TypeWhat It Findsdocker-compose.ymlService dependencies, container links*.yaml (K8s)Container images, service referencespackage.jsonNPM dependencies, internal packagesCargo.tomlRust crate dependenciesDockerfileBase images, internal registriesgo.modGo module dependenciesrequirements.txtPython package dependenciesConfig filesService URLs, API endpoints
🎛️ Customization
Adding Custom Service Patterns
Modify the servicePatterns array in the constructor:
typescriptthis.servicePatterns = [
  /https?:\/\/([a-zA-Z0-9-]+)\.yourcompany\.com/g,  // Your domain
  /service[:-]\s*([a-zA-Z0-9-]+)/gi,                // service: auth-service
  /@yourorg\/([a-zA-Z0-9-]+)/g,                     // @yourorg/service-name
  // Add your patterns here
];
Custom File Types
Add to the isRelevantFile method:
typescriptconst relevantPatterns = [
  /your-config-pattern\.ya?ml$/,
  /custom-service\.json$/,
  // Add your file patterns
];
Confidence Scoring
Adjust confidence levels in the parsing methods based on your needs:

High: Explicit dependencies (package.json, docker-compose depends_on)
Medium: Configuration references, environment variables
Low: Pattern-matched text references

📈 Example Output
High-Impact Services Report
markdown### auth-service
- **Consumer Count:** 23
- **Consumers:** user-api, admin-dashboard, mobile-gateway, ...
- **Produced by:** auth-service-repo

### payment-processor
- **Consumer Count:** 15
- **Consumers:** checkout-service, billing-api, subscription-manager, ...
JSON Graph Structure
json{
  "services": {
    "auth-service": {
      "name": "auth-service",
      "producers": ["auth-service-repo"],
      "consumers": ["user-api", "admin-dashboard"],
      "dependencies": [
        {
          "consumer": "user-api",
          "producer": "auth-service",
          "type": "service",
          "source": "docker-compose.yml",
          "confidence": "high"
        }
      ]
    }
  }
}
🛠️ Advanced Usage
Programmatic Usage
typescriptimport { GitHubServiceAnalyzer } from './dependency-analyzer';

const analyzer = new GitHubServiceAnalyzer(token, orgName);
const graph = await analyzer.analyzeOrganization();

// Custom analysis
const highImpactServices = Array.from(graph.services.entries())
  .filter(([name, service]) => service.consumers.length > 10)
  .sort(([,a], [,b]) => b.consumers.length - a.consumers.length);
Filtering Results
typescript// Filter by confidence level
const highConfidenceDeps = dependencies.filter(dep => dep.confidence === 'high');

// Filter by dependency type
const serviceDeps = dependencies.filter(dep => dep.type === 'service');
🔒 Security & Rate Limits

Token Permissions: Requires repo scope for private repositories
Rate Limiting: Built-in batching (10 repos/batch) with 1-second delays
Error Handling: Gracefully handles repository access issues
No Data Storage: Only analyzes; doesn't modify repositories

🐛 Troubleshooting
Common Issues
Rate Limit Exceeded
bash# Increase delay between batches
// Modify the timeout in analyzeOrganization()
await new Promise(resolve => setTimeout(resolve, 2000)); // 2 seconds
Repository Access Denied

Ensure your token has access to the organization
Check if repositories are private and require additional permissions

Large Organization Timeouts
typescript// Process subset of repositories
const repositories = await this.getAllRepositories();
const subset = repositories.slice(0, 100); // First 100 repos
Debug Mode
Add logging for troubleshooting:
typescriptconsole.log(`Processing ${repoName}...`);
console.log(`Found ${dependencies.length} dependencies`);
🤝 Contributing
Feel free to customize this tool for your organization's needs:

Fork the repository
Add your custom patterns and file types
Test with a subset of repositories first
Submit improvements back to the team

📝 License
MIT License - feel free to use and modify for your organization's needs.
🆘 Support

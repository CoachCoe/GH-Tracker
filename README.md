GitHub Service Dependency Analyzer
A powerful TypeScript tool that analyzes your GitHub organization's repositories to build comprehensive service dependency graphs. Perfect for understanding service relationships, impact analysis, and architectural insights across large codebases.

🎯 What It Does

Discovers Service Dependencies: Scans repositories to find who depends on what
Multi-Format Support: Analyzes Docker Compose, Kubernetes YAML, package.json, Cargo.toml, and more
Impact Analysis: Identifies high-impact services that affect many consumers
Confidence Scoring: Rates dependency detection accuracy (high/medium/low confidence)
Comprehensive Reporting: Generates both human-readable reports and machine-readable JSON
Caching System: Implements intelligent caching to reduce API calls and improve performance
Advanced Filtering: Powerful filtering capabilities for dependency analysis

🚀 Quick Start
Prerequisites

Node.js 16+
GitHub Personal Access Token with repo access
TypeScript (optional, can use ts-node)

Installation
```bash
# Clone or download the analyzer
git clone <your-repo>
cd github-service-analyzer

# Install dependencies
npm install @octokit/rest js-yaml
npm install -D @types/js-yaml typescript ts-node @types/node
```

Configuration
Set up your environment variables:
```bash
# Required: GitHub Personal Access Token
export GITHUB_TOKEN="ghp_your_token_here"

# Required: Your GitHub organization name
export GITHUB_ORG="your-company"
```

Running the Analysis
```bash
# Run the analyzer
npx ts-node dependency-analyzer.ts

# Or compile and run
npx tsc dependency-analyzer.ts
node dependency-analyzer.js
```

📊 Output Files
The analyzer generates two key files:
- `dependency-report.md`: Human-readable markdown report containing:
  - Organization overview and statistics
  - High-impact services ranked by consumer count
  - Detailed dependency listings
  - Impact analysis for change planning
- `dependency-graph.json`: Machine-readable JSON containing:
  - Complete dependency graph data
  - Service nodes with producers and consumers
  - Detailed dependency metadata
  - Confidence scores and source file references

🔧 Supported File Types
The analyzer automatically detects and parses:
| File Type | What It Finds |
|-----------|---------------|
| docker-compose.yml | Service dependencies, container links |
| *.yaml (K8s) | Container images, service references |
| package.json | NPM dependencies, internal packages |
| Cargo.toml | Rust crate dependencies |
| Dockerfile | Base images, internal registries |
| go.mod | Go module dependencies |
| requirements.txt | Python package dependencies |
| Config files | Service URLs, API endpoints |

🎛️ Customization
The analyzer is highly configurable through the `AnalyzerConfig` interface:

```typescript
interface AnalyzerConfig {
  customServicePatterns?: RegExp[];    // Custom regex patterns for service detection
  fileProcessingLimit?: number;        // Max files to process per repo (default: 50)
  rateLimitDelay?: number;             // Delay between API calls in ms (default: 1000)
  cacheEnabled?: boolean;              // Enable/disable caching (default: true)
  cacheDuration?: number;              // Cache duration in ms (default: 3600000)
  debugMode?: boolean;                 // Enable debug logging (default: false)
}
```

Adding Custom Service Patterns
```typescript
const analyzer = new GitHubServiceAnalyzer(token, orgName, {
  customServicePatterns: [
    /https?:\/\/([a-zA-Z0-9-]+)\.yourcompany\.com/g,
    /service[:-]\s*([a-zA-Z0-9-]+)/gi,
    /@yourorg\/([a-zA-Z0-9-]+)/g,
  ]
});
```

Advanced Filtering
```typescript
// Filter by confidence level
const highConfidenceDeps = analyzer.filterByConfidence(dependencies, 'high');

// Filter by dependency type
const serviceDeps = analyzer.filterByType(dependencies, 'service');

// Get high-impact services
const highImpactServices = analyzer.getHighImpactServices(graph, 5); // threshold: 5 consumers
```

🔒 Security & Rate Limits

- Token Permissions: Requires repo scope for private repositories
- Rate Limiting: Built-in batching with configurable delays
- Error Handling: Graceful handling of repository access issues
- No Data Storage: Only analyzes; doesn't modify repositories
- Caching: Reduces API calls and improves performance

🐛 Troubleshooting
Common Issues

Rate Limit Exceeded
```typescript
// Increase delay between batches
const analyzer = new GitHubServiceAnalyzer(token, orgName, {
  rateLimitDelay: 2000 // 2 seconds
});
```

Repository Access Denied
- Ensure your token has access to the organization
- Check if repositories are private and require additional permissions

Debug Mode
```typescript
const analyzer = new GitHubServiceAnalyzer(token, orgName, {
  debugMode: true
});
```

🤝 Contributing
Feel free to customize this tool for your organization's needs:

1. Fork the repository
2. Add your custom patterns and file types
3. Test with a subset of repositories first
4. Submit improvements back to the team

📝 License
MIT License - feel free to use and modify for your organization's needs.

🆘 Support
For issues and feature requests, please open an issue in the repository.

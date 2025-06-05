
import { Octokit } from '@octokit/rest';
import * as yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';

// Types for our dependency analysis
interface ServiceDependency {
  consumer: string; // repository name
  producer: string; // service name or repository
  type: 'service' | 'package' | 'api' | 'docker';
  source: string; // file where dependency was found
  confidence: 'high' | 'medium' | 'low';
}

interface DependencyGraph {
  services: Map<string, ServiceNode>;
  repositories: string[];
}

interface ServiceNode {
  name: string;
  producers: string[]; // repos that provide this service
  consumers: string[]; // repos that use this service
  dependencies: ServiceDependency[];
}

class GitHubServiceAnalyzer {
  private octokit: Octokit;
  private org: string;
  private servicePatterns: RegExp[];

  constructor(token: string, organization: string) {
    this.octokit = new Octokit({ auth: token });
    this.org = organization;
    
    // Common patterns for service references
    this.servicePatterns = [
      /https?:\/\/([a-zA-Z0-9-]+)\.([a-zA-Z0-9-]+)\.internal/g, // internal.company.com
      /service[:-]\s*([a-zA-Z0-9-]+)/gi, // service: auth-service
      /depends_on[:-]\s*\[?([^\]]+)\]?/gi, // depends_on: [auth, user]
      /@([a-zA-Z0-9-]+)\/([a-zA-Z0-9-]+)/g, // @company/service-name
    ];
  }

  async analyzeOrganization(): Promise<DependencyGraph> {
    console.log(`🔍 Starting analysis of ${this.org} organization...`);
    
    const repositories = await this.getAllRepositories();
    console.log(`📦 Found ${repositories.length} repositories`);
    
    const allDependencies: ServiceDependency[] = [];
    
    // Process repositories in batches to avoid rate limits
    const batchSize = 10;
    for (let i = 0; i < repositories.length; i += batchSize) {
      const batch = repositories.slice(i, i + batchSize);
      console.log(`🔄 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(repositories.length/batchSize)}`);
      
      const batchPromises = batch.map(repo => 
        this.analyzeRepository(repo.name).catch(err => {
          console.warn(`⚠️  Error analyzing ${repo.name}: ${err.message}`);
          return [];
        })
      );
      
      const batchResults = await Promise.all(batchPromises);
      allDependencies.push(...batchResults.flat());
      
      // Rate limiting courtesy pause
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return this.buildDependencyGraph(allDependencies, repositories.map(r => r.name));
  }

  private async getAllRepositories() {
    const repositories = [];
    let page = 1;
    
    while (true) {
      const response = await this.octokit.rest.repos.listForOrg({
        org: this.org,
        type: 'all',
        per_page: 100,
        page: page
      });
      
      if (response.data.length === 0) break;
      repositories.push(...response.data);
      page++;
    }
    
    return repositories;
  }

  private async analyzeRepository(repoName: string): Promise<ServiceDependency[]> {
    console.log(`🔍 Analyzing ${repoName}...`);
    const dependencies: ServiceDependency[] = [];
    
    try {
      // Get repository file tree
      const tree = await this.octokit.rest.git.getTree({
        owner: this.org,
        repo: repoName,
        tree_sha: 'HEAD',
        recursive: 'true'
      });

      // Focus on key configuration files
      const relevantFiles = tree.data.tree.filter(item => 
        item.type === 'blob' && this.isRelevantFile(item.path || '')
      );

      // Analyze each relevant file
      for (const file of relevantFiles.slice(0, 20)) { // Limit to avoid rate limits
        try {
          const content = await this.getFileContent(repoName, file.path!);
          const fileDependencies = this.extractDependencies(repoName, file.path!, content);
          dependencies.push(...fileDependencies);
        } catch (err) {
          console.warn(`⚠️  Could not read ${file.path} in ${repoName}`);
        }
      }
    } catch (error) {
      console.warn(`⚠️  Could not access repository ${repoName}`);
    }

    return dependencies;
  }

  private isRelevantFile(filePath: string): boolean {
    const relevantPatterns = [
      /docker-compose\.ya?ml$/,
      /\.ya?ml$/, // Kubernetes, configs
      /package\.json$/,
      /Cargo\.toml$/,
      /go\.mod$/,
      /requirements\.txt$/,
      /Dockerfile$/,
      /\.env/,
      /config\./,
      /service\./,
      /api\./,
    ];
    
    return relevantPatterns.some(pattern => pattern.test(filePath.toLowerCase()));
  }

  private async getFileContent(repoName: string, filePath: string): Promise<string> {
    const response = await this.octokit.rest.repos.getContent({
      owner: this.org,
      repo: repoName,
      path: filePath
    });

    if ('content' in response.data) {
      return Buffer.from(response.data.content, 'base64').toString('utf-8');
    }
    throw new Error('File content not available');
  }

  private extractDependencies(repoName: string, filePath: string, content: string): ServiceDependency[] {
    const dependencies: ServiceDependency[] = [];
    
    // Parse different file types
    if (filePath.endsWith('.json')) {
      dependencies.push(...this.parsePackageJson(repoName, filePath, content));
    } else if (filePath.match(/\.ya?ml$/)) {
      dependencies.push(...this.parseYamlFile(repoName, filePath, content));
    } else if (filePath.includes('Dockerfile')) {
      dependencies.push(...this.parseDockerfile(repoName, filePath, content));
    } else if (filePath.includes('Cargo.toml')) {
      dependencies.push(...this.parseCargoToml(repoName, filePath, content));
    }
    
    // Generic pattern matching for all files
    dependencies.push(...this.parseGenericPatterns(repoName, filePath, content));
    
    return dependencies;
  }

  private parsePackageJson(repoName: string, filePath: string, content: string): ServiceDependency[] {
    const dependencies: ServiceDependency[] = [];
    
    try {
      const pkg = JSON.parse(content);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      
      for (const [depName, version] of Object.entries(allDeps)) {
        // Look for internal packages (company scoped or internal patterns)
        if (depName.startsWith('@') || depName.includes(this.org)) {
          dependencies.push({
            consumer: repoName,
            producer: depName,
            type: 'package',
            source: filePath,
            confidence: 'high'
          });
        }
      }
    } catch (e) {
      // Invalid JSON, skip
    }
    
    return dependencies;
  }

  private parseYamlFile(repoName: string, filePath: string, content: string): ServiceDependency[] {
    const dependencies: ServiceDependency[] = [];
    
    try {
      const doc = yaml.load(content) as any;
      
      // Docker Compose services
      if (doc?.services) {
        for (const [serviceName, serviceConfig] of Object.entries(doc.services)) {
          // depends_on
          if ((serviceConfig as any)?.depends_on) {
            const deps = Array.isArray((serviceConfig as any).depends_on) 
              ? (serviceConfig as any).depends_on 
              : [(serviceConfig as any).depends_on];
            
            deps.forEach((dep: string) => {
              dependencies.push({
                consumer: repoName,
                producer: dep,
                type: 'service',
                source: filePath,
                confidence: 'high'
              });
            });
          }
          
          // External services referenced in environment or image
          if ((serviceConfig as any)?.environment) {
            const envVars = (serviceConfig as any).environment;
            for (const [key, value] of Object.entries(envVars)) {
              if (typeof value === 'string' && this.looksLikeServiceReference(value)) {
                dependencies.push({
                  consumer: repoName,
                  producer: this.extractServiceName(value),
                  type: 'service',
                  source: `${filePath}:${key}`,
                  confidence: 'medium'
                });
              }
            }
          }
        }
      }
      
      // Kubernetes resources
      if (doc?.spec?.containers) {
        doc.spec.containers.forEach((container: any) => {
          if (container.image && container.image.includes(this.org)) {
            dependencies.push({
              consumer: repoName,
              producer: container.image.split(':')[0],
              type: 'docker',
              source: filePath,
              confidence: 'high'
            });
          }
        });
      }
    } catch (e) {
      // Invalid YAML or structure, fall back to text parsing
    }
    
    return dependencies;
  }

  private parseDockerfile(repoName: string, filePath: string, content: string): ServiceDependency[] {
    const dependencies: ServiceDependency[] = [];
    const lines = content.split('\n');
    
    lines.forEach(line => {
      if (line.startsWith('FROM ') && line.includes(this.org)) {
        const imageName = line.split(' ')[1].split(':')[0];
        dependencies.push({
          consumer: repoName,
          producer: imageName,
          type: 'docker',
          source: filePath,
          confidence: 'high'
        });
      }
    });
    
    return dependencies;
  }

  private parseCargoToml(repoName: string, filePath: string, content: string): ServiceDependency[] {
    const dependencies: ServiceDependency[] = [];
    
    // Simple TOML parsing for dependencies section
    const lines = content.split('\n');
    let inDependenciesSection = false;
    
    lines.forEach(line => {
      if (line.trim() === '[dependencies]') {
        inDependenciesSection = true;
        return;
      }
      if (line.trim().startsWith('[') && line.trim() !== '[dependencies]') {
        inDependenciesSection = false;
        return;
      }
      
      if (inDependenciesSection && line.includes('=')) {
        const [depName] = line.split('=').map(s => s.trim());
        // Look for internal crates
        if (depName.includes(this.org) || line.includes('git =')) {
          dependencies.push({
            consumer: repoName,
            producer: depName.replace(/"/g, ''),
            type: 'package',
            source: filePath,
            confidence: 'medium'
          });
        }
      }
    });
    
    return dependencies;
  }

  private parseGenericPatterns(repoName: string, filePath: string, content: string): ServiceDependency[] {
    const dependencies: ServiceDependency[] = [];
    
    this.servicePatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const serviceName = match[1] || match[2];
        if (serviceName && serviceName.length > 2) { // Filter out very short matches
          dependencies.push({
            consumer: repoName,
            producer: serviceName,
            type: 'service',
            source: filePath,
            confidence: 'low'
          });
        }
      }
    });
    
    return dependencies;
  }

  private looksLikeServiceReference(value: string): boolean {
    return value.includes('://') || 
           value.includes('.internal') || 
           value.includes('-service') ||
           value.includes('_service');
  }

  private extractServiceName(value: string): string {
    // Extract service name from URLs or references
    const urlMatch = value.match(/https?:\/\/([^\/]+)/);
    if (urlMatch) return urlMatch[1];
    
    const serviceMatch = value.match(/([a-zA-Z0-9-]+)[-_]service/);
    if (serviceMatch) return serviceMatch[1];
    
    return value;
  }

  private buildDependencyGraph(dependencies: ServiceDependency[], repositories: string[]): DependencyGraph {
    const services = new Map<string, ServiceNode>();
    
    dependencies.forEach(dep => {
      // Initialize producer service node
      if (!services.has(dep.producer)) {
        services.set(dep.producer, {
          name: dep.producer,
          producers: [],
          consumers: [],
          dependencies: []
        });
      }
      
      const serviceNode = services.get(dep.producer)!;
      
      // Add consumer if not already present
      if (!serviceNode.consumers.includes(dep.consumer)) {
        serviceNode.consumers.push(dep.consumer);
      }
      
      // Add producer repository if it's in our org
      if (repositories.includes(dep.producer) && !serviceNode.producers.includes(dep.producer)) {
        serviceNode.producers.push(dep.producer);
      }
      
      serviceNode.dependencies.push(dep);
    });
    
    return { services, repositories };
  }

  async generateReport(graph: DependencyGraph): Promise<string> {
    let report = `# Service Dependency Analysis Report\n\n`;
    report += `**Organization:** ${this.org}\n`;
    report += `**Total Repositories:** ${graph.repositories.length}\n`;
    report += `**Services Identified:** ${graph.services.size}\n`;
    report += `**Analysis Date:** ${new Date().toISOString()}\n\n`;
    
    report += `## High-Impact Services\n\n`;
    const sortedServices = Array.from(graph.services.entries())
      .sort(([,a], [,b]) => b.consumers.length - a.consumers.length);
    
    sortedServices.slice(0, 10).forEach(([serviceName, service]) => {
      report += `### ${serviceName}\n`;
      report += `- **Consumer Count:** ${service.consumers.length}\n`;
      report += `- **Consumers:** ${service.consumers.join(', ')}\n`;
      if (service.producers.length > 0) {
        report += `- **Produced by:** ${service.producers.join(', ')}\n`;
      }
      report += `\n`;
    });
    
    report += `## Detailed Dependencies\n\n`;
    graph.services.forEach((service, serviceName) => {
      if (service.consumers.length > 0) {
        report += `**${serviceName}** is consumed by:\n`;
        service.consumers.forEach(consumer => {
          const deps = service.dependencies.filter(d => d.consumer === consumer);
          report += `- ${consumer} (${deps.length} references)\n`;
        });
        report += `\n`;
      }
    });
    
    return report;
  }
}

// Usage example
async function main() {
  const analyzer = new GitHubServiceAnalyzer(
    process.env.GITHUB_TOKEN!,
    process.env.GITHUB_ORG!
  );
  
  try {
    const graph = await analyzer.analyzeOrganization();
    const report = await analyzer.generateReport(graph);
    
    // Save results
    await fs.writeFile('dependency-report.md', report);
    await fs.writeFile('dependency-graph.json', JSON.stringify(graph, null, 2));
    
    console.log('✅ Analysis complete! Check dependency-report.md and dependency-graph.json');
  } catch (error) {
    console.error('❌ Analysis failed:', error);
  }
}

// Export for use as a module
export { GitHubServiceAnalyzer, ServiceDependency, DependencyGraph };

// Run if this file is executed directly
if (require.main === module) {
  main();
}

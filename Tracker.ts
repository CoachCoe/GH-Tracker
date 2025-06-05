import { Octokit } from '@octokit/rest';
import * as yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';


interface ServiceDependency {
  consumer: string; 
  producer: string; 
  type: 'service' | 'package' | 'api' | 'docker';
  source: string; 
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

interface AnalyzerConfig {
  customServicePatterns?: RegExp[];
  fileProcessingLimit?: number;
  rateLimitDelay?: number;
  cacheEnabled?: boolean;
  cacheDuration?: number; 
  debugMode?: boolean;
}

class GitHubServiceAnalyzer {
  private octokit: Octokit;
  private org: string;
  private servicePatterns: RegExp[];
  private config: AnalyzerConfig;
  private cache: Map<string, { data: any; timestamp: number }>;

  constructor(token: string, organization: string, config: AnalyzerConfig = {}) {
    this.octokit = new Octokit({ auth: token });
    this.org = organization;
    this.config = {
      fileProcessingLimit: 50,
      rateLimitDelay: 1000,
      cacheEnabled: true,
      cacheDuration: 3600000, 
      debugMode: false,
      ...config
    };
    this.cache = new Map();
    
    this.servicePatterns = [
      /https?:\/\/([a-zA-Z0-9-]+)\.([a-zA-Z0-9-]+)\.internal/g,
      /service[:-]\s*([a-zA-Z0-9-]+)/gi,
      /depends_on[:-]\s*\[?([^\]]+)\]?/gi,
      /@([a-zA-Z0-9-]+)\/([a-zA-Z0-9-]+)/g,
      /([a-zA-Z0-9-]+)\.service\./gi,
      /([a-zA-Z0-9-]+)\.api\./gi,
      /([a-zA-Z0-9-]+)\.internal/gi,
      ...(config.customServicePatterns || [])
    ];
  }

  private log(message: string, level: 'info' | 'debug' | 'warn' | 'error' = 'info') {
    if (this.config.debugMode || level !== 'debug') {
      console.log(`[${level.toUpperCase()}] ${message}`);
    }
  }

  private async getCached<T>(key: string, fetchFn: () => Promise<T>): Promise<T> {
    if (!this.config.cacheEnabled) {
      return fetchFn();
    }

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.config.cacheDuration!) {
      this.log(`Cache hit for ${key}`, 'debug');
      return cached.data;
    }

    const data = await fetchFn();
    this.cache.set(key, { data, timestamp: Date.now() });
    return data;
  }

  async analyzeOrganization(): Promise<DependencyGraph> {
    console.log(`🔍 Starting analysis of ${this.org} organization...`);
    
    const repositories = await this.getAllRepositories();
    console.log(`📦 Found ${repositories.length} repositories`);
    
    const allDependencies: ServiceDependency[] = [];
    
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
    this.log(`Analyzing ${repoName}...`, 'debug');
    const dependencies: ServiceDependency[] = [];
    
    try {
      const tree = await this.getCached(
        `tree:${repoName}`,
        () => this.octokit.rest.git.getTree({
          owner: this.org,
          repo: repoName,
          tree_sha: 'HEAD',
          recursive: 'true'
        })
      );

      const relevantFiles = tree.data.tree.filter(item => 
        item.type === 'blob' && this.isRelevantFile(item.path || '')
      );

      const fileLimit = this.config.fileProcessingLimit || 50;
      for (const file of relevantFiles.slice(0, fileLimit)) {
        try {
          const content = await this.getCached(
            `content:${repoName}:${file.path}`,
            () => this.getFileContent(repoName, file.path!)
          );
          const fileDependencies = this.extractDependencies(repoName, file.path!, content);
          dependencies.push(...fileDependencies);
        } catch (err) {
          this.log(`Could not read ${file.path} in ${repoName}`, 'warn');
        }
      }
    } catch (error) {
      this.log(`Could not access repository ${repoName}`, 'error');
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
    
    if (filePath.endsWith('.json')) {
      dependencies.push(...this.parsePackageJson(repoName, filePath, content));
    } else if (filePath.match(/\.ya?ml$/)) {
      dependencies.push(...this.parseYamlFile(repoName, filePath, content));
    } else if (filePath.includes('Dockerfile')) {
      dependencies.push(...this.parseDockerfile(repoName, filePath, content));
    } else if (filePath.includes('Cargo.toml')) {
      dependencies.push(...this.parseCargoToml(repoName, filePath, content));
    }
    
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
      if (!services.has(dep.producer)) {
        services.set(dep.producer, {
          name: dep.producer,
          producers: [],
          consumers: [],
          dependencies: []
        });
      }
      
      const serviceNode = services.get(dep.producer)!;
      
      if (!serviceNode.consumers.includes(dep.consumer)) {
        serviceNode.consumers.push(dep.consumer);
      }
      
      if (repositories.includes(dep.producer) && !serviceNode.producers.includes(dep.producer)) {
        serviceNode.producers.push(dep.producer);
      }
      
      serviceNode.dependencies.push(dep);
    });
    
    return { services, repositories };
  }

  async generateReport(graph: DependencyGraph): Promise<{ markdown: string; json: string }> {
    const markdown = await this.generateMarkdownReport(graph);
    const json = JSON.stringify(graph, null, 2);
    
    await fs.writeFile('dependency-report.md', markdown);
    await fs.writeFile('dependency-graph.json', json);
    
    return { markdown, json };
  }

  private async generateMarkdownReport(graph: DependencyGraph): Promise<string> {
    const highImpactServices = Array.from(graph.services.entries())
      .filter(([_, service]) => service.consumers.length > 5)
      .sort(([_, a], [__, b]) => b.consumers.length - a.consumers.length);

    let report = `# Dependency Analysis Report for ${this.org}\n\n`;
    report += `Generated on: ${new Date().toISOString()}\n\n`;
    
    report += `## High-Impact Services\n\n`;
    for (const [name, service] of highImpactServices) {
      report += `### ${name}\n`;
      report += `- **Consumer Count:** ${service.consumers.length}\n`;
      report += `- **Consumers:** ${service.consumers.join(', ')}\n`;
      report += `- **Produced by:** ${service.producers.join(', ')}\n\n`;
    }

    report += `## Repository Statistics\n\n`;
    report += `- Total Repositories: ${graph.repositories.length}\n`;
    report += `- Services with Dependencies: ${graph.services.size}\n`;
    
    return report;
  }

  filterByConfidence(dependencies: ServiceDependency[], confidence: 'high' | 'medium' | 'low'): ServiceDependency[] {
    return dependencies.filter(dep => dep.confidence === confidence);
  }

  filterByType(dependencies: ServiceDependency[], type: 'service' | 'package' | 'api' | 'docker'): ServiceDependency[] {
    return dependencies.filter(dep => dep.type === type);
  }

  getHighImpactServices(graph: DependencyGraph, threshold: number = 5): Map<string, ServiceNode> {
    return new Map(
      Array.from(graph.services.entries())
        .filter(([_, service]) => service.consumers.length >= threshold)
    );
  }
}

async function main() {
  const analyzer = new GitHubServiceAnalyzer(
    process.env.GITHUB_TOKEN!,
    process.env.GITHUB_ORG!
  );
  
  try {
    const graph = await analyzer.analyzeOrganization();
    const report = await analyzer.generateReport(graph);
    
    await fs.writeFile('dependency-report.md', report.markdown);
    await fs.writeFile('dependency-graph.json', report.json);
    
    console.log('✅ Analysis complete! Check dependency-report.md and dependency-graph.json');
  } catch (error) {
    console.error('❌ Analysis failed:', error);
  }
}

export { GitHubServiceAnalyzer, ServiceDependency, DependencyGraph };

if (require.main === module) {
  main();
}

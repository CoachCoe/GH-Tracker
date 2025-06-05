import { Octokit } from '@octokit/rest';
import * as yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as cliProgress from 'cli-progress';

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['GITHUB_TOKEN', 'GITHUB_ORG'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
  console.error('\nPlease set these variables in your .env file or environment:');
  console.error('GITHUB_TOKEN=your_personal_access_token_here');
  console.error('GITHUB_ORG=your_organization_name');
  process.exit(1);
}

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
  targetRepos?: string[];
}

class GitHubServiceAnalyzer {
  private octokit: Octokit;
  private org: string;
  private servicePatterns: RegExp[];
  private config: AnalyzerConfig;
  private cache: Map<string, { data: any; timestamp: number }>;
  private progressBar: cliProgress.SingleBar;

  constructor(token: string, organization: string, config: AnalyzerConfig = {}) {
    this.octokit = new Octokit({ auth: token });
    this.org = organization;
    this.config = {
      fileProcessingLimit: 50,
      rateLimitDelay: 1000,
      cacheEnabled: true,
      cacheDuration: 3600000, 
      debugMode: true,
      targetRepos: [],
      ...config
    };
    this.cache = new Map();
    this.progressBar = new cliProgress.SingleBar({
      format: 'Progress |{bar}| {percentage}% | {value}/{total} Files | {title}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    });
    
    this.servicePatterns = [
      /https?:\/\/([a-zA-Z0-9-]+)\.([a-zA-Z0-9-]+)\.internal/g,
      /service[:-]\s*([a-zA-Z0-9-]+)/gi,
      /depends_on[:-]\s*\[?([^\]]+)\]?/gi,
      /@([a-zA-Z0-9-]+)\/([a-zA-Z0-9-]+)/g,
      /([a-zA-Z0-9-]+)\.service\./gi,
      /([a-zA-Z0-9-]+)\.api\./gi,
      /([a-zA-Z0-9-]+)\.internal/gi,
      
      /path\s*=\s*["']\.\.\/([^"']+)["']/g,
      /git\s*=\s*["']https:\/\/github\.com\/[^"']+\/([^"']+)["']/g,
      /([a-zA-Z0-9-]+)\s*=\s*\{[^}]*version\s*=\s*["'][^"']+["']/g,
      
      /image:\s*([a-zA-Z0-9-]+\/[a-zA-Z0-9-]+)/g,
      /imagePullPolicy:\s*([a-zA-Z0-9-]+)/g,
      /host:\s*([a-zA-Z0-9-]+\.[a-zA-Z0-9-]+)/g,
      
      /serviceName:\s*([a-zA-Z0-9-]+)/g,
      /endpoint:\s*([a-zA-Z0-9-]+)/g,
      /hostname:\s*([a-zA-Z0-9-]+)/g,
      /([a-zA-Z0-9-]+)_SERVICE/g,
      /([a-zA-Z0-9-]+)_HOST/g,
      /([a-zA-Z0-9-]+)_PORT/g,
      
      /pallet_([a-zA-Z0-9-]+)/g,
      /runtime_([a-zA-Z0-9-]+)/g,
      /([a-zA-Z0-9-]+)_runtime/g,
      /([a-zA-Z0-9-]+)_chain/g,
      /([a-zA-Z0-9-]+)_node/g,
      
      /\.rs$/,
      /\.toml$/,
      /runtime\./i,
      /chain_spec\./i,
      /node\./i,
      /pallet\./i,
      /\.lock$/,
      /build\./i,
      /\.config\./i,
      
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
    
    // Filter repositories if targetRepos is specified
    const reposToAnalyze = this.config.targetRepos?.length 
      ? repositories.filter(r => this.config.targetRepos!.includes(r.name))
      : repositories;
    
    console.log(`🎯 Analyzing ${reposToAnalyze.length} repositories`);
    
    const allDependencies: ServiceDependency[] = [];
    
    const batchSize = 5; // Reduced batch size for better progress tracking
    for (let i = 0; i < reposToAnalyze.length; i += batchSize) {
      const batch = reposToAnalyze.slice(i, i + batchSize);
      console.log(`\n🔄 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(reposToAnalyze.length/batchSize)}`);
      console.log(`   Repositories: ${batch.map(r => r.name).join(', ')}`);
      
      const batchPromises = batch.map(repo => 
        this.analyzeRepository(repo.name).catch(err => {
          console.warn(`⚠️  Error analyzing ${repo.name}: ${err.message}`);
          return [];
        })
      );
      
      const batchResults = await Promise.all(batchPromises);
      const newDependencies = batchResults.flat();
      allDependencies.push(...newDependencies);
      
      console.log(`   ✅ Found ${newDependencies.length} dependencies in this batch`);
      
      // Rate limiting courtesy pause
      await new Promise(resolve => setTimeout(resolve, this.config.rateLimitDelay));
    }

    console.log(`\n📊 Analysis complete. Found ${allDependencies.length} total dependencies.`);
    return this.buildDependencyGraph(allDependencies, reposToAnalyze.map(r => r.name));
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
    console.log(`\n📦 Analyzing ${repoName}...`);
    const dependencies: ServiceDependency[] = [];
    
    try {
      // Get repository details first
      const repoDetails = await this.octokit.rest.repos.get({
        owner: this.org,
        repo: repoName
      });
      
      console.log(`   - Language: ${repoDetails.data.language || 'Not specified'}`);
      console.log(`   - Size: ${Math.round(repoDetails.data.size / 1024)}MB`);
      
      // Get only the root tree first
      const rootTree = await this.octokit.rest.git.getTree({
        owner: this.org,
        repo: repoName,
        tree_sha: 'HEAD',
        recursive: 'false'
      });
      
      // Find relevant directories
      const relevantDirs = rootTree.data.tree
        .filter(item => item.type === 'tree' && (
          item.path === 'src' ||
          item.path === 'runtime' ||
          item.path === 'pallets' ||
          item.path === 'node' ||
          item.path === 'scripts' ||
          item.path === 'docker' ||
          item.path === 'config'
        ));
      
      console.log(`   - Found ${relevantDirs.length} relevant directories`);
      
      // Process each relevant directory
      for (const dir of relevantDirs) {
        console.log(`   - Processing ${dir.path}/...`);
        const dirTree = await this.octokit.rest.git.getTree({
          owner: this.org,
          repo: repoName,
          tree_sha: dir.sha!,
          recursive: 'true'
        });
        
        const relevantFiles = dirTree.data.tree.filter(item => 
          item.type === 'blob' && this.isRelevantFile(item.path || '')
        );
        
        console.log(`     Found ${relevantFiles.length} relevant files`);
        
        const fileLimit = this.config.fileProcessingLimit || 100;
        const filesToProcess = relevantFiles.slice(0, fileLimit);
        
        // Initialize progress bar for this directory
        this.progressBar.start(filesToProcess.length, 0, { title: dir.path });
        
        for (let i = 0; i < filesToProcess.length; i++) {
          const file = filesToProcess[i];
          try {
            const content = await this.getCached(
              `content:${repoName}:${file.path}`,
              () => this.getFileContent(repoName, file.path!)
            );
            const fileDependencies = this.extractDependencies(repoName, file.path!, content);
            dependencies.push(...fileDependencies);
            
            if (this.config.debugMode) {
              console.log(`\n     - ${file.path}: Found ${fileDependencies.length} dependencies`);
            }
          } catch (err) {
            if (this.config.debugMode) {
              console.log(`\n     - Could not read ${file.path}`);
            }
          }
          
          // Update progress bar
          this.progressBar.update(i + 1, { title: `${dir.path}/${file.path}` });
        }
        
        // Stop progress bar for this directory
        this.progressBar.stop();
      }
      
      // Also check root level config files
      const rootFiles = rootTree.data.tree.filter(item => 
        item.type === 'blob' && this.isRelevantFile(item.path || '')
      );
      
      console.log(`   - Processing ${rootFiles.length} root level config files`);
      
      // Initialize progress bar for root files
      this.progressBar.start(rootFiles.length, 0, { title: 'root' });
      
      for (let i = 0; i < rootFiles.length; i++) {
        const file = rootFiles[i];
        try {
          const content = await this.getCached(
            `content:${repoName}:${file.path}`,
            () => this.getFileContent(repoName, file.path!)
          );
          const fileDependencies = this.extractDependencies(repoName, file.path!, content);
          dependencies.push(...fileDependencies);
          
          if (this.config.debugMode) {
            console.log(`\n     - ${file.path}: Found ${fileDependencies.length} dependencies`);
          }
        } catch (err) {
          if (this.config.debugMode) {
            console.log(`\n     - Could not read ${file.path}`);
          }
        }
        
        // Update progress bar
        this.progressBar.update(i + 1, { title: file.path });
      }
      
      // Stop progress bar for root files
      this.progressBar.stop();
      
    } catch (error: any) {
      console.error(`   ❌ Error analyzing ${repoName}:`, error.message);
    }
    
    console.log(`   ✅ Found ${dependencies.length} total dependencies in ${repoName}`);
    return dependencies;
  }

  private isRelevantFile(filePath: string): boolean {
    // Skip files in certain directories
    if (filePath.includes('/target/') || 
        filePath.includes('/node_modules/') ||
        filePath.includes('/.git/') ||
        filePath.includes('/.github/')) {
      return false;
    }

    const relevantPatterns = [
      // Configuration files
      /^Cargo\.toml$/,  // Root Cargo.toml
      /^docker-compose\.ya?ml$/,
      /^\.env$/,
      /^config\.ya?ml$/,
      
      // Rust specific
      /^runtime\/.*\.rs$/,  // Runtime files
      /^pallets\/.*\/Cargo\.toml$/,  // Pallet Cargo.toml files
      /^pallets\/.*\/lib\.rs$/,  // Pallet lib files
      
      // Docker/Kubernetes
      /^docker\/.*\.ya?ml$/,
      /^docker\/.*Dockerfile$/,
      
      // Build and config
      /^\.cargo\/config\.toml$/,
      /^scripts\/.*\.sh$/,
      /^scripts\/.*\.py$/,
      
      // Documentation with potential service references
      /^README\.md$/,
      /^docs\/.*\.md$/
    ];
    
    return relevantPatterns.some(pattern => pattern.test(filePath));
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

  async checkRateLimit() {
    const rateLimit = await this.octokit.rest.rateLimit.get();
    return {
      remaining: rateLimit.data.resources.core.remaining,
      reset: new Date(rateLimit.data.resources.core.reset * 1000).toLocaleString()
    };
  }
}

async function main() {
  const config: AnalyzerConfig = {
    fileProcessingLimit: parseInt(process.env.FILE_PROCESSING_LIMIT || '100'),
    rateLimitDelay: parseInt(process.env.RATE_LIMIT_DELAY || '1000'),
    cacheEnabled: process.env.CACHE_ENABLED !== 'false',
    cacheDuration: parseInt(process.env.CACHE_DURATION || '3600000'),
    debugMode: true,
    targetRepos: ['polkadot-sdk']
  };

  const analyzer = new GitHubServiceAnalyzer(
    process.env.GITHUB_TOKEN!,
    process.env.GITHUB_ORG!,
    config
  );
  
  try {
    console.log(`🔍 Starting analysis of ${process.env.GITHUB_ORG} organization...`);
    console.log(`📦 Focusing on repository: ${config.targetRepos![0]}`);
    
    // Add rate limit check
    const rateLimit = await analyzer.checkRateLimit();
    console.log(`\n📊 Current GitHub API Status:`);
    console.log(`   - Remaining requests: ${rateLimit.remaining}`);
    console.log(`   - Reset time: ${rateLimit.reset}`);
    
    const graph = await analyzer.analyzeOrganization();
    const report = await analyzer.generateReport(graph);
    
    await fs.writeFile('dependency-report.md', report.markdown);
    await fs.writeFile('dependency-graph.json', report.json);
    
    console.log('\n✅ Analysis complete! Check dependency-report.md and dependency-graph.json');
  } catch (error) {
    console.error('❌ Analysis failed:', error);
    process.exit(1);
  }
}

export { GitHubServiceAnalyzer, ServiceDependency, DependencyGraph };

if (require.main === module) {
  main();
}

import { Octokit } from '@octokit/rest';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function testSpecificRepos(octokit: Octokit, repos: string[]) {
  console.log('\n🔍 Testing specific repositories...');
  
  for (const repo of repos) {
    try {
      const response = await octokit.rest.repos.get({
        owner: process.env.GITHUB_ORG!,
        repo: repo
      });
      
      console.log(`✅ ${repo}:`);
      console.log(`   - Description: ${response.data.description || 'No description'}`);
      console.log(`   - Language: ${response.data.language || 'Not specified'}`);
      console.log(`   - Stars: ${response.data.stargazers_count}`);
      console.log(`   - Visibility: ${response.data.visibility}`);
      
      // Test file access
      const treeResponse = await octokit.rest.git.getTree({
        owner: process.env.GITHUB_ORG!,
        repo: repo,
        tree_sha: 'HEAD',
        recursive: 'true'
      });
      
      const relevantFiles = treeResponse.data.tree.filter(item => 
        item.type === 'blob' && (
          item.path?.endsWith('docker-compose.yml') ||
          item.path?.endsWith('package.json') ||
          item.path?.endsWith('Cargo.toml') ||
          item.path?.match(/\.ya?ml$/)
        )
      );
      
      console.log(`   - Found ${relevantFiles.length} relevant configuration files`);
      if (relevantFiles.length > 0) {
        console.log('   - Sample files:');
        relevantFiles.slice(0, 3).forEach(file => {
          console.log(`     * ${file.path}`);
        });
      }
      
    } catch (error: any) {
      console.error(`❌ ${repo}: ${error.message}`);
    }
  }
}

async function testConfig() {
  // Check required environment variables
  const requiredEnvVars = ['GITHUB_TOKEN', 'GITHUB_ORG'];
  const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingEnvVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
    process.exit(1);
  }

  console.log('✅ Environment variables loaded');
  console.log(`Organization: ${process.env.GITHUB_ORG}`);

  // Initialize Octokit
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  try {
    // Test organization access
    console.log('\n🔍 Testing organization access...');
    const orgResponse = await octokit.rest.orgs.get({
      org: process.env.GITHUB_ORG!
    });
    console.log(`✅ Successfully accessed organization: ${orgResponse.data.name}`);
    console.log(`   Description: ${orgResponse.data.description || 'No description'}`);
    console.log(`   Public repos: ${orgResponse.data.public_repos}`);

    // Test repository listing
    console.log('\n📦 Testing repository access...');
    const reposResponse = await octokit.rest.repos.listForOrg({
      org: process.env.GITHUB_ORG!,
      per_page: 5
    });
    
    console.log('✅ Successfully listed repositories:');
    reposResponse.data.forEach(repo => {
      console.log(`   - ${repo.name} (${repo.visibility})`);
    });

    // Test specific repositories
    const reposToTest = [
      'polkadot-sdk',  // Main SDK repository
      'substrate',     // Substrate framework
      'smoldot'        // Light client
    ];
    
    await testSpecificRepos(octokit, reposToTest);

    console.log('\n✨ Configuration test completed successfully!');
  } catch (error: any) {
    console.error('\n❌ Configuration test failed:');
    if (error.status === 404) {
      console.error('   Organization not found. Please check the organization name.');
    } else if (error.status === 401) {
      console.error('   Authentication failed. Please check your GitHub token.');
    } else if (error.status === 403) {
      console.error('   Access forbidden. Please check your token permissions.');
    } else {
      console.error('   Error:', error.message);
    }
    process.exit(1);
  }
}

testConfig(); 
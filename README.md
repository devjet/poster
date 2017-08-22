# poster
Poting content from VK to twitter made easy.

Objective
--------
Make automated posting content from VK to twitter. 
Each twitter accout shoul be configured separately for content selecting by length, type and likes count. Also there shoul be flexible method to setup posting interval.


Usage
-----

1. You need to have [PM2](https://github.com/Unitech/pm2) intalled in order to manage node processes.
2. Configure your twitter accounts in ```ecosystem.json```
3. Run script ```pm2 startOrRestart ecosystem.json --env production```

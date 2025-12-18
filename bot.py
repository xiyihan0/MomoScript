import nonebot
from nonebot.adapters.onebot.v11 import Adapter as ONEBOT_V11Adapter

# 初始化 NoneBot
# command_start=[""] 表示不需要前缀直接发命令，或者你可以设为 ["/"]
nonebot.init(command_start=["/"]) 

driver = nonebot.get_driver()
driver.register_adapter(ONEBOT_V11Adapter)

nonebot.load_plugins("nonebot_plugin_mmt_pipe")


if __name__ == "__main__":
    nonebot.run()

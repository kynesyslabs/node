from textual.app import App, ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import Button, Static
from textual.widgets import RichLog, Input
import subprocess
import sys
import os
from threading import Thread
from time import sleep



demosNode = None
text_log = None
text_log = None
node_pid = None
writer_thread = None
stop_force = False


class DemosTUI(App[str]):
    
    CSS = """
RichLog {
	border: solid;
}
"""

    def compose(self) -> ComposeResult:
        yield Horizontal(
                RichLog(highlight=True, markup=True, wrap=True, name="log"),
		)
        yield Horizontal(
            VerticalScroll(
                Static("Controls", classes="header"),
                #Button("Default", disabled=True),
                #Button("Primary!", variant="primary", disabled=True),
                Horizontal(
					Button.success("Start", disabled=False, name="start"),
					Button.warning("Restart", disabled=False, name="restart"),
					Button.error("Stop", disabled=False, name="stop"),
				),
                Horizontal(
                    Button("Update DEMOS", disabled=False, name="update"),
				),
				Button.error("Quit", disabled=False, name="quit"),
				Static("DEMOS TUI"),
				Static("(c) 2023 KyneSys Labs"),
            ),
        )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        text_log.write(event.button.name)
        if event.button.name == "start":
            text_log.write("Starting the node...")
            starter()
        elif event.button.name == "restart":
            text_log.write("Restarting the node...")
            stopper()
            starter()
        elif event.button.name == "stop":
            text_log.write("Stopping the node...")
            text_log.write(f"Stopping the node...: {str(demosNode.pid)}")
            stopper()
        elif event.button.name == "quit":
            text_log.write("Quitting the node...")
            stopper()
            sys.exit()
        elif event.button.name == "update":
            text_log.write("Updating DEMOS...")
            updater()
            
    
    def on_ready(self) -> None:
        global text_log
        texts = self.query(RichLog)
        text_log = texts[0]

def writer():
    global node_pid
    global demosNode
    global stop_force
    global text_log
    while not stop_force:
        for line in iter(demosNode.stdout.readline, b''):
            text_log.write(line.rstrip().decode("utf-8"))



def updater():
	global node_pid
	global demosNode
	global loop
	global writer_thread
	demosNode = subprocess.Popen(["git", "pull"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
	node_pid = demosNode.pid
 
	writer_thread = Thread(target=writer)
	writer_thread.start()
	
    
# INFO Starting the node and logging the output
def starter():
	global node_pid
	global demosNode
	global loop
	global writer_thread
	demosNode = subprocess.Popen(["yarn", "start"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
	node_pid = demosNode.pid
 
	writer_thread = Thread(target=writer)
	writer_thread.start()
 
 
	#loop.run_forever()
	#while True:
		# Use read1() instead of read() or Popen.communicate() as both blocks until EOF
		# https://docs.python.org/3/library/io.html#io.BufferedIOBase.read1
	#	output = demosNode.stdout.read1().decode("utf-8")
	#	text_log.write(output)


def stopper():
    global demosNode
    global stop_force
    global writer_thread
    demosNode.terminate()
    stop_force = True
    writer_thread.join()
 
if __name__ == "__main__":
    app = DemosTUI()
    print(app.run())
